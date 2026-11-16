import { app, type ProxyConfig } from 'electron'
import { isIP } from 'node:net'
import { z } from 'zod'

const proxyServerSchema = z
  .object({
    scheme: z.enum(['http', 'https', 'quic', 'socks4', 'socks5']).default('http'),
    host: z
      .string()
      .min(1)
      .refine(
        (host) => /^[a-zA-Z0-9._-]+$/.test(host) || isIP(host.replace(/^\[|\]$/g, '')) !== 0,
        'Invalid proxy host'
      ),
    port: z.number().int().min(1).max(65535).optional()
  })
  .transform((server) => ({
    ...server,
    port:
      server.port ?? { http: 80, https: 443, quic: 443, socks4: 1080, socks5: 1080 }[server.scheme]
  }))

const proxyRulesSchema = z
  .object({
    singleProxy: proxyServerSchema.optional(),
    proxyForHttp: proxyServerSchema.optional(),
    proxyForHttps: proxyServerSchema.optional(),
    proxyForFtp: proxyServerSchema.optional(),
    fallbackProxy: proxyServerSchema.optional(),
    bypassList: z.array(z.string().refine((rule) => !/[,;\r\n]/.test(rule))).optional()
  })
  .refine(
    (rules) =>
      !rules.singleProxy ||
      ![rules.proxyForHttp, rules.proxyForHttps, rules.proxyForFtp, rules.fallbackProxy].some(
        Boolean
      ),
    'singleProxy cannot be combined with per-protocol proxies'
  )

const pacScriptSchema = z
  .object({
    data: z.string().optional(),
    url: z.union([z.url(), z.literal('')]).optional(),
    mandatory: z.boolean().optional()
  })
  .refine((script) => Boolean(script.data) !== Boolean(script.url), 'Specify PAC data or URL')
  // Electron's setProxy always uses mandatory PAC, including when callers omit the flag.
  .transform((script) => ({ ...script, mandatory: true as const }))

export const browserExtensionProxyConfigSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('direct') }),
  z.object({ mode: z.literal('system') }),
  z.object({ mode: z.literal('auto_detect') }),
  z.object({ mode: z.literal('pac_script'), pacScript: pacScriptSchema }),
  z.object({ mode: z.literal('fixed_servers'), rules: proxyRulesSchema })
])

export type BrowserExtensionProxyConfig = z.infer<typeof browserExtensionProxyConfigSchema>

/** setProxy replaces Electron's command-line preference, so release must replay its switches. */
export function browserExtensionProxyBaseline(): ProxyConfig {
  const commandLine = app.commandLine
  if (commandLine.hasSwitch('no-proxy-server')) {
    return { mode: 'direct' }
  }
  const pacScript = commandLine.getSwitchValue('proxy-pac-url')
  if (pacScript) {
    return { mode: 'pac_script', pacScript }
  }
  if (commandLine.hasSwitch('proxy-auto-detect')) {
    return { mode: 'auto_detect' }
  }
  const proxyRules = commandLine.getSwitchValue('proxy-server')
  return proxyRules
    ? {
        mode: 'fixed_servers',
        proxyRules,
        proxyBypassRules: commandLine.getSwitchValue('proxy-bypass-list')
      }
    : { mode: 'system' }
}

export function fromElectronProxyConfig(config: ProxyConfig): BrowserExtensionProxyConfig {
  if (config.mode === 'pac_script') {
    return browserExtensionProxyConfigSchema.parse({
      mode: config.mode,
      pacScript: { url: config.pacScript }
    })
  }
  if (config.mode !== 'fixed_servers') {
    return { mode: config.mode ?? 'system' }
  }
  if (!config.proxyRules) {
    return { mode: 'direct' }
  }
  const server = (list: string, defaultScheme = 'http') => {
    // Chrome's ProxyRules expose one server per scheme, not the native failover list.
    const uri = list
      .split(',')
      .map((entry) => entry.trim())
      .find(Boolean)
    if (!uri || /^direct:\/\/$/i.test(uri)) {
      return undefined
    }
    const url = new URL(uri.includes('://') ? uri : `${defaultScheme}://${uri}`)
    const scheme = url.protocol.slice(0, -1)
    return proxyServerSchema.parse({
      host: url.hostname,
      scheme: scheme === 'socks' ? 'socks4' : scheme,
      ...(url.port ? { port: Number(url.port) } : {})
    })
  }
  const rules: z.infer<typeof proxyRulesSchema> = {}
  for (const entry of config.proxyRules
    .split(';')
    .map((rule) => rule.trim())
    .filter(Boolean)) {
    const match = /^(http|https|ftp|socks)=(.*)$/.exec(entry)
    if (!match) {
      rules.singleProxy = server(entry)
    } else {
      const key = {
        http: 'proxyForHttp',
        https: 'proxyForHttps',
        ftp: 'proxyForFtp',
        socks: 'fallbackProxy'
      }[match[1]]
      if (
        key === 'proxyForHttp' ||
        key === 'proxyForHttps' ||
        key === 'proxyForFtp' ||
        key === 'fallbackProxy'
      ) {
        rules[key] = server(match[2], key === 'fallbackProxy' ? 'socks4' : 'http')
      }
    }
  }
  if (config.proxyBypassRules) {
    rules.bypassList = config.proxyBypassRules
      .split(/[;,]/)
      .map((rule) => rule.trim())
      .filter(Boolean)
  }
  return { mode: 'fixed_servers', rules }
}

export function toElectronProxyConfig(config: BrowserExtensionProxyConfig): ProxyConfig {
  if (config.mode === 'pac_script') {
    return {
      mode: config.mode,
      pacScript:
        config.pacScript.url ||
        `data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(config.pacScript.data ?? '').toString('base64')}`
    }
  }
  if (config.mode !== 'fixed_servers') {
    return { mode: config.mode }
  }
  const serverUri = (server: z.infer<typeof proxyServerSchema>) => {
    const host =
      server.host.includes(':') && !server.host.startsWith('[') ? `[${server.host}]` : server.host
    return `${server.scheme}://${host}:${server.port}`
  }
  const { rules } = config
  return {
    mode: config.mode,
    proxyRules: rules.singleProxy
      ? serverUri(rules.singleProxy)
      : [
          rules.proxyForHttp && `http=${serverUri(rules.proxyForHttp)}`,
          rules.proxyForHttps && `https=${serverUri(rules.proxyForHttps)}`,
          rules.proxyForFtp && `ftp=${serverUri(rules.proxyForFtp)}`,
          rules.fallbackProxy && `socks=${serverUri(rules.fallbackProxy)}`
        ]
          .filter(Boolean)
          .join(';'),
    proxyBypassRules: rules.bypassList?.join(',') ?? ''
  }
}
