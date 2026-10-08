import { createServer } from 'node:https'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runProcess } from '../../src/shared/child-process/run-process'

/**
 * A real TLS origin for the artifact's images, because interception could not measure them.
 *
 * The rig used to answer `https://…invalid` through Playwright's route interception. On Chrome 152
 * the sandboxed `srcdoc` frame is isolated into its own target, and the parser-inserted `<img>` is
 * the first fetch the document makes -- earlier than interception is attached to that target. The
 * request escaped to the real network, `.invalid` did not resolve, and the rig recorded nothing
 * while the document's own resource timing showed the fetch. A listener that is already accepting
 * before the page is created cannot be raced that way: the request either arrives or it does not,
 * and either answer is the measurement.
 *
 * `img-src 'self' data: https:` matches on scheme, so `https://127.0.0.1:<port>` exercises the same
 * directive any other https host would.
 */

/** A 1x1 PNG, the smallest body that lets an admitted image request finish rather than error. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
)

/**
 * A throwaway certificate, generated per run into the suite's own scratch directory.
 *
 * Never committed and never reused: the key exists for the lifetime of one temp directory, and the
 * context that talks to it is created with `ignoreHTTPSErrors`, so nothing here is trusted by
 * anything. `-subj` and `-days 1` keep it obviously disposable.
 */
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

/**
 * Starts the listener and hands back what it saw.
 *
 * Recorded server-side, the way the cleartext origin in this rig already is: a hit is a request that
 * arrived, and a referrer is the header that came with it, neither of them mediated by anything the
 * browser might attach late. Requests carry each arm's nonce, so one list serves every arm and an
 * arm reads only its own.
 */
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
    // Without this every cross-origin resource-timing field reads zero, so a healthy request and a
    // failed one are indistinguishable from inside the frame -- measured, not assumed.
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
    /** This arm's requests only, by nonce, as paths. */
    hitsFor: (nonce) =>
      hits.filter((one) => one.query.includes(`n=${nonce}`)).map((one) => one.path),
    referersFor: (nonce) =>
      hits.filter((one) => one.query.includes(`n=${nonce}`)).map((one) => one.referer),
    /** Whether one exact path arrived, for the probe that issues a URL nothing can have cached. */
    saw: (path) => hits.some((one) => one.path === path)
  }
}
