import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const APP_DIR = `${import.meta.dirname}/..`

/** Reads a wrangler .jsonc (full-line comments only, as ours are written). */
function wranglerConfig(file: string): {
  name?: string
  services?: { binding: string; service: string }[]
  vars?: Record<string, string>
} {
  const text = readFileSync(`${APP_DIR}/${file}`, 'utf8')
  return JSON.parse(
    text
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n')
  )
}

// Every billing config that names a control plane, including wrangler.prod.jsonc once launch
// step 1.2 adds it.
const configs = readdirSync(APP_DIR).filter((file) => /^wrangler(\..+)?\.jsonc$/.test(file))

describe('billing wrangler configs', () => {
  it('finds the dev config', () => {
    expect(configs).toContain('wrangler.dev.jsonc')
  })

  // Same-account Workers can't fetch each other over workers.dev or their custom domains
  // (Cloudflare error 1042): without the binding every setup's GitHub step answers "unavailable".
  it.each(configs)('%s reaches the control plane it names over a service binding', (file) => {
    const config = wranglerConfig(file)
    if (!config.vars?.SANDBOX_CONTROL_URL) {
      return
    }
    const binding = config.services?.find((service) => service.binding === 'SANDBOX_CONTROL')
    expect(binding, `${file} needs services: [{ binding: "SANDBOX_CONTROL", ... }]`).toBeDefined()
    // Dev billing binds the dev control plane, prod binds prod: never across environments.
    const suffix = config.name?.match(/-(dev|prod|staging)$/)?.[1]
    if (suffix) {
      expect(binding!.service).toMatch(new RegExp(`-${suffix}$`))
    }
  })
})
