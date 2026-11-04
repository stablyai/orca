import { generateKeyPairSync } from 'node:crypto'
import * as fs from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const expoRequire = createRequire(require.resolve('expo'))
const metroRequire = createRequire(expoRequire.resolve('@expo/metro/package.json'))
const fileMapRequire = createRequire(metroRequire.resolve('metro-file-map'))
const micromatchRequire = createRequire(fileMapRequire.resolve('micromatch'))
const braces = micromatchRequire('braces')
const cliRequire = createRequire(expoRequire.resolve('@expo/cli'))
const globRequire = createRequire(cliRequire.resolve('glob'))
const configRequire = createRequire(cliRequire.resolve('@expo/config'))
const tempDirs: string[] = []

function makeTree(dir: string, depth: number) {
  fs.writeFileSync(join(dir, 'f'), '')
  for (const child of depth ? ['a', 'b'] : []) {
    fs.mkdirSync(join(dir, child))
    makeTree(join(dir, child), depth - 1)
  }
}

type BraceNode = { type: string; value?: string; nodes?: BraceNode[] }

describe('installed mobile dependency security patches', () => {
  it.each([
    ['braces', '{', '}'],
    ['parentheses', '(', ')'],
    ['mixed nesting', '{(', ')}']
  ])('bounds %s during parsing', (_name, open, close) => {
    expect(() => braces.parse(`${open.repeat(512)}a,b${close.repeat(512)}`)).toThrow(
      'maximum nesting depth'
    )
  })

  it.each(['compile', 'expand', 'stringify'])('bounds nested patterns in braces.%s', (method) => {
    const pattern = `${'{'.repeat(4_000)}a,b${'}'.repeat(4_000)}`
    expect(() => braces[method](pattern)).toThrow('maximum nesting depth')
    expect(braces.expand('src/{main,shared}/*.ts')).toEqual(['src/main/*.ts', 'src/shared/*.ts'])
  })

  it.each(['compile', 'expand', 'stringify'])(
    'bounds directly supplied ASTs in braces.%s',
    (method) => {
      let ast: BraceNode = { type: 'text', value: 'ok' }
      for (let depth = 0; depth < 10_000; depth += 1) {
        ast = { type: 'root', nodes: [ast] }
      }
      expect(() => braces[method](ast)).toThrow('maximum nesting depth')
    }
  )

  it.each([true, false])(
    'rejects extra DigestAlgorithm elements with NULL parameters: %s',
    (parameters) => {
      const forge = cliRequire('node-forge')
      const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024, publicExponent: 3 })
      const key = forge.pki.privateKeyFromPem(
        privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
      )
      const publicKey = forge.pki.setRsaPublicKey(key.n, key.e)
      const md = forge.md.sha256.create().update('release payload')
      const digest = md.digest().getBytes()
      expect(publicKey.verify(digest, key.sign(md))).toBe(true)
      const { asn1 } = forge
      const element = (type: number, value: unknown, constructed = false) =>
        asn1.create(asn1.Class.UNIVERSAL, type, constructed, value)
      const algorithm = element(
        asn1.Type.SEQUENCE,
        [
          element(asn1.Type.OID, asn1.oidToDer(forge.pki.oids.sha256).getBytes()),
          ...(parameters ? [element(asn1.Type.NULL, '')] : [])
        ],
        true
      )
      const digestInfo = element(
        asn1.Type.SEQUENCE,
        [algorithm, element(asn1.Type.OCTETSTRING, digest)],
        true
      )
      const valid = key.sign(asn1.toDer(digestInfo).getBytes(), 'NONE')
      expect(publicKey.verify(digest, valid)).toBe(true)
      algorithm.value.push(element(asn1.Type.OCTETSTRING, 'unexpected padding'))
      const signature = key.sign(asn1.toDer(digestInfo).getBytes(), 'NONE')
      expect(() => publicKey.verify(digest, signature)).toThrow('DigestInfo')
    }
  )

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('bounds **/.. pattern splitting in minimatch 10.2.5', () => {
    const { Minimatch } = globRequire('minimatch')
    expect(globRequire('minimatch/package.json').version).toBe('10.2.5')
    const amplified = Array(10).fill('**/../a/b').join('/')
    expect(new Minimatch(amplified, { optimizationLevel: 2, braceExpandMax: 64 }).set).toHaveLength(
      64
    )
    const mm = new Minimatch('**/../a/b/**/../c/d', { optimizationLevel: 2 })
    expect(mm.set).toHaveLength(4)
    expect(mm.match('x/a/b/y/c/d')).toBe(true)
  })

  it('stops glob 13 directory reads after an abort', async () => {
    const { glob } = cliRequire('glob')
    expect(cliRequire('glob/package.json').version).toBe('13.0.6')
    const cwd = mkdtempSync(join(tmpdir(), 'orca-mobile-glob-abort-'))
    tempDirs.push(cwd)
    makeTree(cwd, 5)
    const controller = new AbortController()
    let reads = 0
    // Settles after the latest read's callback has run, so follow-up reads are already counted.
    let lastRead = Promise.resolve()
    const countedFs = {
      ...fs,
      readdir: (
        path: fs.PathLike,
        options: { withFileTypes: true },
        callback: (error: Error | null, entries: fs.Dirent[]) => void
      ) => {
        if (++reads === 1) {
          controller.abort(new Error('stop'))
        }
        let settle: () => void = () => {}
        lastRead = new Promise((resolve) => {
          settle = resolve
        })
        fs.readdir(path, options, (error, entries) => {
          callback(error, entries)
          settle()
        })
      }
    }
    await expect(glob('**', { cwd, signal: controller.signal, fs: countedFs })).rejects.toThrow(
      'stop'
    )
    await lastRead
    expect(reads).toBe(1)
    expect(await glob('**/f', { cwd })).toHaveLength(63)
  })

  it('keeps own __proto__ keys from replacing the deepmerge result prototype', () => {
    const deepmerge = configRequire('deepmerge')
    expect(configRequire('deepmerge/package.json').version).toBe('4.3.1')
    const merged = deepmerge(
      JSON.parse('{"__proto__":{"polluted":true},"a":{"b":1}}'),
      JSON.parse('{"__proto__":{"injected":true},"a":{"c":2}}')
    )
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype)
    expect(merged.polluted).toBeUndefined()
    expect(merged.injected).toBeUndefined()
    expect(Object.getOwnPropertyDescriptor(merged, '__proto__')?.value).toEqual({
      polluted: true,
      injected: true
    })
    expect(merged.a).toEqual({ b: 1, c: 2 })
  })
})
