import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose'
import { z } from 'zod'

export type UpstreamConfig = { issuer: string; clientId: string; clientSecret?: string; tokenEndpointAuthMethod?: 'client_secret_basic' | 'client_secret_post'; allowedEmails?: string[]; allowedDomains?: string[]; keepSecretLogin?: boolean; allowAny?: boolean; allowCrossOrigin?: boolean }
const documentSchema = z.object({ issuer: z.string(), token_endpoint_auth_methods_supported: z.array(z.string()).optional(), authorization_endpoint: z.string().url(), token_endpoint: z.string().url(), jwks_uri: z.string().url(), userinfo_endpoint: z.string().url().optional() })

export function allowedEmail(config: UpstreamConfig, value: string) {
  if (!/^[\x21-\x7e]+@[\x21-\x7e]+$/.test(value) || value.split('@').length !== 2) return false
  const email = value.toLowerCase(), emails = config.allowedEmails ?? [], domains = config.allowedDomains ?? []
  return emails.includes(email) || domains.includes(email.split('@')[1] ?? '') || (!emails.length && !domains.length && config.allowAny === true)
}

export function upstreamOidc(config: UpstreamConfig, callback: string) {
  let cache: { document: z.infer<typeof documentSchema>; expires: number } | undefined
  function validateEndpoint(url: string) {
    const target = new URL(url)
    const issuer = new URL(config.issuer)
    if (target.protocol !== 'https:' && !(issuer.protocol === 'http:' && target.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname))) throw new Error('invalid_endpoint')
    if (!config.allowCrossOrigin && target.origin !== issuer.origin) throw new Error('invalid_endpoint_origin')
  }
  async function json(url: string, init: RequestInit = {}) {
    validateEndpoint(url)
    const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(5000) })
    if (!response.ok || !response.body) throw new Error('upstream request failed')
    const reader = response.body.getReader(), chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.length
        if (size > 65536) { await reader.cancel(); throw new Error('upstream response too large') }
        chunks.push(value)
      }
    } finally { reader.releaseLock() }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  }
  async function discovery() {
    if (cache && cache.expires > Date.now()) return cache.document
    const document = documentSchema.parse(await json(`${config.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`))
    if (document.issuer !== config.issuer) throw new Error('issuer mismatch')
    for (const endpoint of [document.authorization_endpoint, document.token_endpoint, document.jwks_uri, document.userinfo_endpoint]) if (endpoint) validateEndpoint(endpoint)
    cache = { document, expires: Date.now() + 300_000 }
    return document
  }
  return {
    async authorize(state: string, nonce: string, challenge: string) {
      const url = new URL((await discovery()).authorization_endpoint)
      for (const [key, value] of Object.entries({ client_id: config.clientId, response_type: 'code', redirect_uri: callback, scope: 'openid email profile', state, nonce, code_challenge: challenge, code_challenge_method: 'S256' })) url.searchParams.set(key, value)
      return url.toString()
    },
    async exchange(code: string, verifier: string, nonce: string) {
      const document = await discovery()
      const params = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: callback, client_id: config.clientId, code_verifier: verifier })
      const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' }
      if (config.clientSecret) {
        const supported = document.token_endpoint_auth_methods_supported ?? ['client_secret_basic']
        const method = config.tokenEndpointAuthMethod ?? (supported.includes('client_secret_basic') ? 'client_secret_basic' : supported.includes('client_secret_post') ? 'client_secret_post' : undefined)
        if (!method) throw new Error('unsupported_client_authentication')
        if (method === 'client_secret_post') params.set('client_secret', config.clientSecret)
        else {
          const encode = (value: string) => new URLSearchParams({ value }).toString().slice(6)
          headers.authorization = `Basic ${Buffer.from(`${encode(config.clientId)}:${encode(config.clientSecret)}`).toString('base64')}`
          params.delete('client_id')
        }
      }
      const result = z.object({ id_token: z.string(), access_token: z.string().optional() }).parse(await json(document.token_endpoint, { method: 'POST', headers, body: params }))
      const jwks = z.object({ keys: z.array(z.record(z.string(), z.unknown())) }).parse(await json(document.jwks_uri)) as JSONWebKeySet
      const { payload } = await jwtVerify(result.id_token, createLocalJWKSet(jwks), { issuer: config.issuer, audience: config.clientId, algorithms: ['RS256', 'ES256', 'EdDSA'], requiredClaims: ['sub', 'exp', 'iat'] })
      if (payload.nonce !== nonce || !payload.sub) throw new Error('invalid_identity')
      if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== config.clientId) throw new Error('invalid_authorized_party')
      let claims = payload
      if ((!payload.email || !payload.name) && document.userinfo_endpoint && result.access_token) {
        let userinfo: { sub: string; email?: string; email_verified?: boolean; name?: string } | undefined
        try {
          userinfo = z.object({ sub: z.string(), email: z.string().optional(), email_verified: z.boolean().optional(), name: z.string().optional() }).parse(await json(document.userinfo_endpoint, { headers: { authorization: `Bearer ${result.access_token}` } }))
        } catch (error) { if (!payload.email || payload.email_verified !== true) throw error }
        if (userinfo) {
          if (userinfo.sub !== payload.sub) throw new Error('invalid_userinfo')
          claims = { ...payload, email: payload.email ?? userinfo.email, email_verified: payload.email ? payload.email_verified : userinfo.email_verified, name: payload.name ?? userinfo.name }
        }
      }
      if (claims.email_verified !== true) throw new Error('email_unverified')
      if (typeof claims.email !== 'string' || !allowedEmail(config, claims.email)) throw new Error('email_not_allowed')
      return { userId: `${Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(config.issuer))).toString('base64url')}:${payload.sub}`, email: claims.email, name: typeof claims.name === 'string' ? claims.name : '' }
    }
  }
}
