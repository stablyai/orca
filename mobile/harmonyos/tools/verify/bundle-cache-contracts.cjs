const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { loadArkts } = require('./arkts-source.cjs')
const bundleCompat = require('../../entry/src/main/ets/vendor/bundle-compat.js')

const sha256 = (value) => new Uint8Array(createHash('sha256').update(value).digest())
const fileIo = {
  OpenMode: {
    READ_WRITE: fs.constants.O_RDWR,
    CREATE: fs.constants.O_CREAT,
    TRUNC: fs.constants.O_TRUNC
  },
  mkdirSync: (name, recursive) => fs.mkdirSync(name, { recursive }),
  statSync: fs.statSync,
  readTextSync: (name) => fs.readFileSync(name, 'utf8'),
  openSync: (name, mode) => ({ fd: fs.openSync(name, mode) }),
  writeSync: (fd, data) => fs.writeSync(fd, typeof data === 'string' ? data : Buffer.from(data)),
  closeSync: (file) => fs.closeSync(file.fd),
  fsyncSync: fs.fsyncSync,
  renameSync: fs.renameSync,
  unlinkSync: fs.unlinkSync
}
class RpcSuccess {
  constructor(id, result) {
    this.id = id
    this.result = result
  }
}
function manifest(content) {
  return {
    schemaVersion: 1,
    runtimeProtocolVersion: 3,
    minCompatibleRuntimeProtocolVersion: 2,
    pageVersion: 3,
    buildId: 'same-build-id',
    entrypoint: 'index.html',
    desktopVersion: '1',
    routes: [],
    chunkBytes: 49152,
    rangeBytes: 0,
    assets: [
      {
        path: 'index.html',
        sha256: createHash('sha256').update(content).digest('hex'),
        byteLength: Buffer.byteLength(content),
        contentType: 'text/html'
      }
    ]
  }
}
function fetcher(root, content, options = {}) {
  const { WebBundleFetcher } = loadArkts('transport/WebBundleFetcher.ets', ['WebBundleFetcher'], {
    fs: fileIo,
    RpcSuccess,
    bundleCompat,
    sha256,
    utf8Encode: (value) => new TextEncoder().encode(value),
    base64Decode: (value) => new Uint8Array(Buffer.from(value, 'base64'))
  })
  const client = {
    request: async () =>
      new RpcSuccess(
        'status',
        JSON.stringify(
          options.status ?? {
            protocolVersion: 3,
            minCompatibleMobileVersion: 2,
            capabilities: ['mobileWeb.bundle.v1']
          }
        )
      ),
    buildWire: (_id, method, params) => ({ method, params }),
    requestRaw: async (id, { method, params }) => {
      if (method === 'mobileWeb.bundle.manifest') {
        options.onManifest?.()
        return new RpcSuccess(
          id,
          JSON.stringify({ manifest: { ...manifest(content), ...options.manifest } })
        )
      }
      const request = JSON.parse(params)
      return new RpcSuccess(
        id,
        JSON.stringify({ ...request, dataBase64: Buffer.from(content).toString('base64') })
      )
    }
  }
  return new WebBundleFetcher(client, { cacheDir: root })
}

test('two desktop bundles with the same build id cannot reuse each other’s code', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-bundle-cache-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  await fetcher(root, 'desktop A bundle').ensureBundle(manifest('desktop A bundle'))
  const second = await fetcher(root, 'desktop B bundle').ensureBundle(manifest('desktop B bundle'))
  assert.equal(fs.readFileSync(path.join(second, 'index.html'), 'utf8'), 'desktop B bundle')
})

test('a completion marker does not hide an evicted bundle asset', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-bundle-cache-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const loader = fetcher(root, 'complete bundle')
  const directory = await loader.ensureBundle(manifest('complete bundle'))
  fs.unlinkSync(path.join(directory, 'index.html'))
  const restored = await loader.ensureBundle(manifest('complete bundle'))
  assert.equal(fs.readFileSync(path.join(restored, 'index.html'), 'utf8'), 'complete bundle')
})

test('cold offline startup can reopen only the verified bundle for this pairing', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-bundle-cache-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const context = { cacheDir: root }
  const hostA = 'a'.repeat(32)
  const hostB = 'b'.repeat(32)
  const online = fetcher(root, 'desktop A offline bundle')
  const installed = await online.fetchManifest()
  const directory = await online.ensureBundle(installed)
  online.constructor.rememberPairedBundle(context, hostA, 100, installed)

  const offline = fetcher(root, 'unrelated response').constructor
  const restored = offline.readPairedBundle(context, hostA, 100)
  assert.equal(restored.directory, directory)
  assert.equal(
    fs.readFileSync(path.join(restored.directory, 'index.html'), 'utf8'),
    'desktop A offline bundle'
  )
  assert.equal(offline.readPairedBundle(context, hostB, 100), null)
  assert.equal(offline.readPairedBundle(context, hostA, 200), null)
  fs.unlinkSync(path.join(directory, 'index.html'))
  assert.equal(offline.readPairedBundle(context, hostA, 100), null)

  await online.ensureBundle(installed)
  offline.forgetPairedBundle(context, hostA)
  assert.equal(offline.readPairedBundle(context, hostA, 100), null)
})

test('a downloaded replacement is ready for the next entry while offline still opens the last painted bundle', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-bundle-cache-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const context = { cacheDir: root }
  const host = 'a'.repeat(32)
  const first = fetcher(root, 'working page')
  const working = await first.fetchManifest()
  const active = await first.ensureBundle(working)
  first.constructor.rememberPairedBundle(context, host, 100, working)

  const next = fetcher(root, 'new workspace page')
  const offered = await next.fetchManifest()
  assert.equal(next.completedDirectory(offered), null)
  const staged = await next.ensureBundle(offered)
  assert.equal(next.completedDirectory(offered), staged)
  assert.notEqual(staged, active)
  assert.equal(next.constructor.readPairedBundle(context, host, 100).directory, active)
  fs.unlinkSync(path.join(staged, 'index.html'))
  assert.equal(next.completedDirectory(offered), null)
  assert.equal(next.constructor.readPairedBundle(context, host, 100).directory, active)
})

test('compatibility distinguishes desktop updates, app updates and stale workspace bundles', async () => {
  let requestedManifest = false
  const noBundle = fetcher('', '', {
    status: { protocolVersion: 3, minCompatibleMobileVersion: 2, capabilities: [] },
    onManifest: () => {
      requestedManifest = true
    }
  })
  await assert.rejects(noBundle.fetchManifest(), {
    remedy: 'desktop',
    message: 'bundle-unavailable'
  })
  assert.equal(requestedManifest, false)
  await assert.rejects(fetcher('', '', { manifest: { schemaVersion: 2 } }).fetchManifest(), {
    remedy: 'mobile',
    message: 'bundle-shell-too-old'
  })
  await assert.rejects(fetcher('', '', { manifest: { pageVersion: 0 } }).fetchManifest(), {
    remedy: 'desktop',
    message: 'bundle-incompatible'
  })
  await assert.rejects(
    fetcher('', '', { manifest: { runtimeProtocolVersion: 1 } }).fetchManifest(),
    { remedy: 'workspace', message: 'bundle-incompatible' }
  )
})
