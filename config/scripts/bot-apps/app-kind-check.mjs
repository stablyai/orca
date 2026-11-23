import { checkResourceAllowed } from '@modelcontextprotocol/sdk/shared/auth-utils.js'
import {
  OAuthMetadataSchema,
  OAuthProtectedResourceMetadataSchema,
  OpenIdProviderDiscoveryMetadataSchema
} from '@modelcontextprotocol/sdk/shared/auth.js'
import {
  InitializeResultSchema,
  LATEST_PROTOCOL_VERSION,
  ListToolsResultSchema
} from '@modelcontextprotocol/sdk/types.js'

class AppCheckFailure extends Error {}

const fail = (message) => {
  throw new AppCheckFailure(message)
}

const MCP_ACCEPT = 'application/json, text/event-stream'

function initializeRequest() {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'orca-bot-app-check', version: '1' }
    }
  }
}

function eventStreamMessages(text) {
  const messages = []
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n')
    if (data) {
      try {
        messages.push(JSON.parse(data))
      } catch {
        // Non-JSON events (pings, comments) are not replies.
      }
    }
  }
  return messages
}

function rpcReply(response, id, method) {
  const contentType = response.headers.get('content-type') ?? ''
  let messages
  if (contentType.includes('text/event-stream')) {
    messages = eventStreamMessages(response.text)
  } else {
    try {
      messages = [JSON.parse(response.text)].flat()
    } catch {
      fail(`${method} reply is not JSON`)
    }
  }
  const reply = messages.find((message) => message?.id === id)
  if (!reply) {
    fail(`${method} got no reply with id ${id}`)
  }
  if (reply.error) {
    fail(`${method} returned error ${reply.error.code}: ${reply.error.message}`)
  }
  return reply.result
}

function schemaProblem(result) {
  return result.error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ')
}

function parseWith(schema, value, what) {
  const result = schema.safeParse(value)
  if (!result.success) {
    fail(`${what} is invalid (${schemaProblem(result)})`)
  }
  return result.data
}

function jsonBody(response, what) {
  try {
    return JSON.parse(response.text)
  } catch {
    return fail(`${what} at ${response.url} is not JSON`)
  }
}

async function checkOpenApp(app, client) {
  const post = (headers, message) =>
    client.post(
      app.url,
      { accept: MCP_ACCEPT, 'content-type': 'application/json', ...headers },
      JSON.stringify(message)
    )

  const initialized = await post({}, initializeRequest())
  if (initialized.status !== 200) {
    fail(`initialize answered ${initialized.status}, expected 200 without sign-in`)
  }
  const init = parseWith(
    InitializeResultSchema,
    rpcReply(initialized, 1, 'initialize'),
    'initialize result'
  )

  const session = initialized.headers.get('mcp-session-id')
  const followUp = {
    'mcp-protocol-version': init.protocolVersion,
    ...(session ? { 'mcp-session-id': session } : {})
  }
  const notified = await post(followUp, { jsonrpc: '2.0', method: 'notifications/initialized' })
  if (notified.status < 200 || notified.status >= 300) {
    fail(`notifications/initialized answered ${notified.status}`)
  }

  const listed = await post(followUp, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
  if (listed.status !== 200) {
    fail(`tools/list answered ${listed.status}`)
  }
  const tools = parseWith(
    ListToolsResultSchema,
    rpcReply(listed, 2, 'tools/list'),
    'tools/list result'
  )
  return `initialize ok (${init.protocolVersion}), ${tools.tools.length} tools`
}

/** The parameters of the Bearer challenge, or null when the header offers no Bearer scheme. */
export function bearerChallenge(header) {
  const match = /(?:^|,)\s*Bearer(?=$|[\s,])/i.exec(header ?? '')
  if (!match) {
    return null
  }
  const rest = header.slice(match.index + match[0].length)
  const params = {}
  const param = /\s*,?\s*([A-Za-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/y
  for (let found = param.exec(rest); found; found = param.exec(rest)) {
    params[found[1].toLowerCase()] = found[2]?.replace(/\\(.)/g, '$1') ?? found[3]
  }
  return params
}

function wellKnownUrls(base, suffix) {
  const url = new URL(base)
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '')
  return [
    ...new Set([
      `${url.origin}/.well-known/${suffix}${path}`,
      `${url.origin}/.well-known/${suffix}`
    ])
  ]
}

async function firstFound(client, urls, what) {
  const misses = []
  for (const url of urls) {
    const response = await client.get(url, { accept: 'application/json' })
    if (response.status === 200) {
      return response
    }
    misses.push(`${url} ${response.status}`)
  }
  return fail(`no ${what} found (${misses.join(', ')})`)
}

const ADVERTISED_ENDPOINTS = [
  'authorization_endpoint',
  'token_endpoint',
  'registration_endpoint',
  'jwks_uri'
]

/** Fails unless the issuer publishes metadata a sign-in can use; returns the metadata URL. */
async function checkAuthorizationServer(client, issuer) {
  const issuerUrl = new URL(issuer)
  const path = issuerUrl.pathname === '/' ? '' : issuerUrl.pathname.replace(/\/$/, '')
  const candidates = [
    {
      url: `${issuerUrl.origin}/.well-known/oauth-authorization-server${path}`,
      schema: OAuthMetadataSchema
    },
    {
      url: `${issuerUrl.origin}/.well-known/openid-configuration${path}`,
      schema: OpenIdProviderDiscoveryMetadataSchema
    },
    ...(path
      ? [
          {
            url: `${issuerUrl.origin}${path}/.well-known/openid-configuration`,
            schema: OpenIdProviderDiscoveryMetadataSchema
          }
        ]
      : [])
  ]
  const misses = []
  for (const { url, schema } of candidates) {
    const response = await client.get(url, { accept: 'application/json' })
    if (response.status !== 200) {
      misses.push(`${url} ${response.status}`)
      continue
    }
    const metadata = parseWith(schema, jsonBody(response, 'server metadata'), `metadata at ${url}`)
    // RFC 8414 section 3.3 and OpenID discovery both bind the document to the exact issuer asked for.
    if (metadata.issuer !== issuer) {
      fail(`${url} names issuer ${metadata.issuer}, expected ${issuer}`)
    }
    if (!metadata.registration_endpoint) {
      fail(`${url} offers no registration_endpoint`)
    }
    if (!metadata.response_types_supported.includes('code')) {
      fail(`${url} does not support response type code`)
    }
    if (!metadata.code_challenge_methods_supported?.includes('S256')) {
      fail(`${url} does not list PKCE method S256`)
    }
    for (const field of ADVERTISED_ENDPOINTS) {
      if (metadata[field] !== undefined) {
        await client
          .vet(metadata[field])
          .catch((error) => fail(`${url} ${field}: ${error.message}`))
      }
    }
    return url
  }
  return fail(`no metadata for ${issuer} (${misses.join(', ')})`)
}

async function checkSignInApp(app, client) {
  const refused = await client.post(
    app.url,
    { accept: MCP_ACCEPT, 'content-type': 'application/json' },
    JSON.stringify(initializeRequest())
  )
  if (refused.status !== 401) {
    fail(`unauthenticated initialize answered ${refused.status}, expected 401`)
  }
  const challenge = bearerChallenge(refused.headers.get('www-authenticate'))
  if (!challenge) {
    fail('401 carries no Bearer WWW-Authenticate challenge')
  }

  const metadataUrls = challenge.resource_metadata
    ? [new URL(challenge.resource_metadata, app.url).href]
    : wellKnownUrls(app.url, 'oauth-protected-resource')
  const found = await firstFound(client, metadataUrls, 'protected-resource metadata')
  const resource = parseWith(
    OAuthProtectedResourceMetadataSchema,
    jsonBody(found, 'protected-resource metadata'),
    `protected-resource metadata at ${found.url}`
  )
  if (
    !checkResourceAllowed({ requestedResource: app.url, configuredResource: resource.resource })
  ) {
    fail(`metadata resource ${resource.resource} does not cover ${app.url}`)
  }
  const servers = resource.authorization_servers ?? []
  if (servers.length === 0) {
    fail(`protected-resource metadata at ${found.url} lists no authorization server`)
  }

  const problems = []
  for (const server of servers) {
    try {
      await checkAuthorizationServer(client, server)
      return `401 Bearer; resource ${resource.resource}; ${server} offers registration, code, S256`
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error))
    }
  }
  return fail(problems.join(' | '))
}

/** Checks one listed app against what its signIn kind promises. Never throws. */
export async function checkApp(app, client) {
  try {
    const detail =
      app.signIn === 'none' ? await checkOpenApp(app, client) : await checkSignInApp(app, client)
    return { id: app.id, url: app.url, signIn: app.signIn, ok: true, detail }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { id: app.id, url: app.url, signIn: app.signIn, ok: false, detail }
  }
}
