// An MCP app that is its own authorization server, on 127.0.0.1, for sign-in tests.
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { z } from 'zod'

export type Hit = {
  method: string
  path: string
  body: URLSearchParams | Record<string, unknown> | null
}

/** An MCP app on 127.0.0.1 that is also its own authorization server. */
export class FakeApp {
  server!: Server
  base = ''
  hits: Hit[] = []
  metadata: Record<string, unknown> = {}
  challenges = new Map<string, string>()
  /** Answers the next token request instead of the normal flow. */
  tokenAnswer: ((params: URLSearchParams) => Promise<[number, unknown]>) | null = null
  issued = 0
  rotate = true

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    const address = this.server.address()
    this.base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
    this.metadata = {
      issuer: this.base,
      authorization_endpoint: `${this.base}/authorize`,
      token_endpoint: `${this.base}/token`,
      registration_endpoint: `${this.base}/register`,
      revocation_endpoint: `${this.base}/revoke`,
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['read', 'offline_access'],
      authorization_response_iss_parameter_supported: true
    }
  }

  get url(): string {
    return `${this.base}/mcp`
  }

  /** What the user's browser does after approving: the code for this authorization URL. */
  approve(authorizationUrl: string): string {
    const url = new URL(authorizationUrl)
    const code = `code-${this.challenges.size + 1}`
    this.challenges.set(code, url.searchParams.get('code_challenge') ?? '')
    return code
  }

  hitsTo(path: string): Hit[] {
    return this.hits.filter((hit) => hit.path === path)
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk))
    }
    const text = Buffer.concat(chunks).toString('utf8')
    const path = (req.url ?? '').split('?')[0]!
    const body = !text
      ? null
      : req.headers['content-type']?.includes('json')
        ? z.record(z.string(), z.unknown()).parse(JSON.parse(text))
        : new URLSearchParams(text)
    this.hits.push({ method: req.method ?? '', path, body })
    const json = (status: number, value: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers })
      res.end(JSON.stringify(value))
    }
    if (path === '/mcp') {
      json(
        401,
        { error: 'unauthorized' },
        {
          'www-authenticate': `Bearer resource_metadata="${this.base}/.well-known/oauth-protected-resource/mcp", scope="read"`
        }
      )
    } else if (path === '/.well-known/oauth-protected-resource/mcp') {
      json(200, {
        resource: this.url,
        authorization_servers: [this.base],
        scopes_supported: ['read']
      })
    } else if (path === '/.well-known/oauth-authorization-server') {
      json(200, this.metadata)
    } else if (path === '/register') {
      json(201, { ...body, client_id: 'orca-client' })
    } else if (path === '/token') {
      const params = form(body)
      if (this.tokenAnswer) {
        const answer = this.tokenAnswer
        this.tokenAnswer = null
        const [status, value] = await answer(params)
        json(status, value)
        return
      }
      if (params.get('grant_type') === 'authorization_code') {
        const challenge = this.challenges.get(params.get('code') ?? '')
        const verifier = createHash('sha256')
          .update(params.get('code_verifier') ?? '')
          .digest('base64url')
        if (!challenge || challenge !== verifier) {
          json(400, { error: 'invalid_grant' })
          return
        }
        this.challenges.delete(params.get('code')!)
      }
      this.issued += 1
      json(200, {
        access_token: `access-${this.issued}`,
        token_type: 'Bearer',
        expires_in: 3600,
        ...(this.rotate || params.get('grant_type') === 'authorization_code'
          ? { refresh_token: `refresh-${this.issued}` }
          : {})
      })
    } else if (path === '/revoke') {
      res.writeHead(200)
      res.end()
    } else {
      json(404, {})
    }
  }
}

function form(body: Hit['body']): URLSearchParams {
  if (!(body instanceof URLSearchParams)) {
    throw new Error('expected a form body')
  }
  return body
}
