// Guard: an isolate serves many requests, and a promise is bound to the request that
// started it. Module-level state must never hold an in-flight promise (a cancelled request's promise never
// settles and hangs everyone awaiting it), and jose's createRemoteJWKSet (which shares its fetch) is banned:
// use settledRemoteJWKSet. A line that is genuinely safe (e.g. a WebCrypto import, not request I/O) says so
// with `xreq-ok: <reason>`.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('../src', import.meta.url).href)

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : []
  })
}

const RULES: { name: string; pattern: RegExp }[] = [
  { name: 'createRemoteJWKSet shares one in-flight fetch', pattern: /\bcreateRemoteJWKSet\s*\(/ },
  { name: 'module-level Map holding promises', pattern: /^(?:export )?(?:const|let) \w+\s*=\s*new Map<[^>]*Promise</ },
  { name: 'module-level variable typed as a promise', pattern: /^(?:export )?let \w+\s*:[^=]*\bPromise</ },
  { name: 'module-level object holding a promise', pattern: /^(?:export )?let \w+\s*:\s*\{[^}]*:\s*Promise</ }
]

describe('no cross-request promises', () => {
  it('src never caches an in-flight promise at module level, nor uses createRemoteJWKSet', () => {
    const found: string[] = []
    for (const file of files(SRC)) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (line.includes('xreq-ok:')) {
            return
          }
          for (const rule of RULES) {
            if (rule.pattern.test(line)) {
              found.push(`${file.slice(SRC.length + 1)}:${index + 1} ${rule.name}`)
            }
          }
        })
    }
    expect(found).toEqual([])
  })
})
