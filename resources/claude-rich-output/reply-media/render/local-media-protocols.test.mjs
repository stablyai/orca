import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { runProcess } from '@orca/process-host'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'local-media-protocols-')))
after(() => rmSync(root, { recursive: true, force: true }))
const segment = join(root, 'clip.ts')
const made = await runProcess({
  program: 'ffmpeg',
  args: [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=64x48:r=25:d=2',
    '-c:v',
    'mpeg2video',
    '-f',
    'mpegts',
    segment
  ],
  timeoutMs: 20_000,
  terminationBarrier: true
})
assert.equal(made.code, 0, made.stderr)

const picture = join(import.meta.dirname, 'picture.mjs')
const video = join(import.meta.dirname, 'video.mjs')
const pictureArgs =
  process.platform === 'darwin'
    ? [
        '--input-type=module',
        '-e',
        `Object.defineProperty(process, 'platform', { value: 'linux' }); await import(${JSON.stringify(pathToFileURL(picture).href)});`
      ]
    : [picture]

async function renderer(args, path, directory) {
  return runProcess({
    program: process.execPath,
    args,
    input: path,
    cwd: directory,
    env: {
      ...process.env,
      TMPDIR: directory,
      TMP: directory,
      TEMP: directory,
      ORCA_BACKGROUND_LAUNCH: '1'
    },
    timeoutMs: 20_000,
    terminationBarrier: true
  })
}

async function serveSegment(t) {
  const requests = []
  const server = createServer((request, response) => {
    requests.push(request.url)
    response.writeHead(200, { 'Content-Type': 'video/mp2t' })
    response.end(readFileSync(segment))
  })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { requests, url: `http://127.0.0.1:${String(address.port)}/clip.ts` }
}

for (const { name, args } of [
  { name: 'picture converter (dispatch simulated on macOS)', args: pictureArgs },
  { name: 'video poster', args: [video] },
  { name: 'video frame probe', args: [video, 'frames'] }
]) {
  test(`${name} refuses HTTP segments inside a local playlist`, async (t) => {
    const directory = realpathSync(mkdtempSync(join(root, 'case-')))
    const { requests, url } = await serveSegment(t)
    const playlist = join(directory, 'playlist.m3u8')
    writeFileSync(
      playlist,
      [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:1',
        '#EXT-X-MEDIA-SEQUENCE:0',
        '#EXTINF:1,',
        url,
        '#EXT-X-ENDLIST',
        ''
      ].join('\n')
    )
    const result = await renderer(args, playlist, directory)
    assert.deepEqual(requests, [], 'renderer fetched an HTTP segment')
    assert.notEqual(result.code, 0)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /not on whitelist/i)
  })
}

test('video frame extraction keeps its own file-only policy after a successful probe', async (t) => {
  const directory = realpathSync(mkdtempSync(join(root, 'frames-')))
  const lead = join(directory, 'lead.ts')
  const made = await runProcess({
    program: 'ffmpeg',
    args: [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=64x48:r=25:d=20',
      '-c:v',
      'mpeg2video',
      '-f',
      'mpegts',
      lead
    ],
    timeoutMs: 20_000,
    terminationBarrier: true
  })
  assert.equal(made.code, 0, made.stderr)
  const { requests, url } = await serveSegment(t)
  const playlist = join(directory, 'playlist.m3u8')
  writeFileSync(
    playlist,
    [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:20',
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXTINF:20,',
      'lead.ts',
      '#EXT-X-DISCONTINUITY',
      '#EXTINF:2,',
      url,
      '#EXT-X-ENDLIST',
      ''
    ].join('\n')
  )
  const probe = await runProcess({
    program: 'ffprobe',
    args: [
      '-v',
      'error',
      '-protocol_whitelist',
      'file',
      '-show_entries',
      'format=duration',
      '-of',
      'csv=p=0',
      playlist
    ],
    timeoutMs: 20_000,
    terminationBarrier: true
  })
  assert.equal(probe.code, 0, probe.stderr)
  assert.ok(Number(probe.stdout) > 20)
  assert.deepEqual(requests, [], 'the probe should read only the local lead segment')
  const result = await renderer([video, 'frames'], playlist, directory)
  assert.deepEqual(requests, [], 'frame extraction fetched an HTTP segment')
  if (result.code === 0) {
    const frames = JSON.parse(result.stdout)
    assert.ok(frames.count > 0)
    const png = readFileSync(join(frames.dir, 'f00001.png'))
    assert.equal(png.toString('latin1', 1, 4), 'PNG')
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [64, 48])
  } else {
    assert.match(result.stderr, /not on whitelist/i)
  }
})

test('the FFmpeg picture path still converts an ordinary local JPEG', async () => {
  const directory = realpathSync(mkdtempSync(join(root, 'local-')))
  const jpeg = join(directory, 'image.jpg')
  const made = await runProcess({
    program: 'ffmpeg',
    args: [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=64x48',
      '-frames:v',
      '1',
      '-threads',
      '1',
      jpeg
    ],
    timeoutMs: 20_000,
    terminationBarrier: true
  })
  assert.equal(made.code, 0, made.stderr)
  const result = await renderer(pictureArgs, jpeg, directory)
  assert.equal(result.code, 0, result.stderr)
  const converted = JSON.parse(result.stdout)
  const png = readFileSync(converted.file)
  assert.equal(png.toString('latin1', 1, 4), 'PNG')
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [64, 48])
})
