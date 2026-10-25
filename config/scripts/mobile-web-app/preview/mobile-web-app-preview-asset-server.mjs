import { createServer } from 'node:https'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'

// Real TLS listener starts before page: Chrome sandboxed-srcdoc target’s first parser image can race route interception and escape measurement.
// Loopback HTTPS exercises img-src scheme gate like remote HTTPS without DNS dependency.

// 1×1 PNG lets admitted image load finish successfully.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
)

// Generate disposable one-day certificate in suite scratch; context ignores its errors and key disappears with temp directory.
async function generateCertificate(scratch) {
  const keyPath = join(scratch, 'artifact-assets-key.pem')
  const certPath = join(scratch, 'artifact-assets-cert.pem')
  const result = await runProcess({
    program: 'openssl',
    args: [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1'
    ]
  })
  if (result.code !== 0) {
    throw new Error(`openssl could not generate a test certificate: ${result.stderr.slice(0, 400)}`)
  }
  await writeFile(join(scratch, '.gitignore'), '*\n')
  return {
    key: await readFile(keyPath),
    cert: await readFile(certPath)
  }
}

// Record requests/referrers server-side, immune to late browser interception; per-arm URL nonce attributes shared listener hits.
export async function startArtifactAssetServer(scratch) {
  const credentials = await generateCertificate(scratch)
  const hits = []
  const server = createServer(credentials, (request, response) => {
    const url = new URL(request.url ?? '/', 'https://127.0.0.1')
    hits.push({
      path: url.pathname,
      query: url.search,
      referer: request.headers.referer ?? null
    })
    // Timing-Allow-Origin exposes nonzero cross-origin resource timing needed to distinguish healthy and failed requests.
    const timingVisible = { 'timing-allow-origin': '*' }
    if (url.pathname.endsWith('.png')) {
      response.writeHead(200, { 'content-type': 'image/png', ...timingVisible })
      response.end(PNG_1X1)
      return
    }
    if (url.pathname.endsWith('.woff2')) {
      response.writeHead(200, { 'content-type': 'font/woff2', ...timingVisible })
      response.end(Buffer.alloc(0))
      return
    }
    response.writeHead(200, { 'content-type': 'text/html', ...timingVisible })
    response.end('<html><body>ASSET</body></html>')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    server,
    origin: `https://127.0.0.1:${String(server.address().port)}`,
    hitsFor: (nonce) =>
      hits.filter((one) => one.query.includes(`n=${nonce}`)).map((one) => one.path),
    referersFor: (nonce) =>
      hits.filter((one) => one.query.includes(`n=${nonce}`)).map((one) => one.referer),
    saw: (path) => hits.some((one) => one.path === path)
  }
}
