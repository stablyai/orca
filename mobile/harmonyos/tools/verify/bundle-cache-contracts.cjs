const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { loadArkts } = require('./arkts-source.cjs')

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
  closeSync: (file) => fs.closeSync(file.fd)
}
class RpcSuccess {
  constructor(id, result) {
    this.id = id
    this.result = result
  }
}
function manifest(content) {
  return {
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
function fetcher(root, content) {
  const { WebBundleFetcher } = loadArkts('transport/WebBundleFetcher.ets', ['WebBundleFetcher'], {
    fs: fileIo,
    RpcSuccess,
    sha256,
    utf8Encode: (value) => new TextEncoder().encode(value),
    base64Decode: (value) => new Uint8Array(Buffer.from(value, 'base64'))
  })
  const client = {
    buildWire: (_id, _method, params) => params,
    requestRaw: async (id, params) => {
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
