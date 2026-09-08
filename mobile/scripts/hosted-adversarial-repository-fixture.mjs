import { execFile } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { deflateSync } from 'node:zlib'

const execFileAsync = promisify(execFile)
const fixturePrefix = 'orca-mobile-adversarial.'
export const HOSTED_ADVERSARIAL_FILENAME_MARKER = 'ORCA_ADVERSARIAL_FILENAME'
export const HOSTED_ADVERSARIAL_CONTENT_MARKER = 'ORCA_ADVERSARIAL_CONTENT'
export const HOSTED_ADVERSARIAL_WORKSPACE_ROW = 'orca-adversarial-row'
export const HOSTED_ADVERSARIAL_FILENAME = `000-<img src=x onerror=globalThis.${HOSTED_ADVERSARIAL_FILENAME_MARKER}=1>.tsx`
export const HOSTED_ADVERSARIAL_CONTENT = `<img src=x onerror="globalThis.${HOSTED_ADVERSARIAL_CONTENT_MARKER}=1">`
export const HOSTED_ADVERSARIAL_MARKDOWN_FILENAME = '001-adversarial.md'
export const HOSTED_ADVERSARIAL_HTML_FILENAME = '002-adversarial.html'
export const HOSTED_ADVERSARIAL_SVG_FILENAME = '003-adversarial.svg'
export const HOSTED_ADVERSARIAL_IMAGE_FILENAME = '004-adversarial.png'
export const HOSTED_ADVERSARIAL_MARKDOWN_MARKER = 'ORCA_ADVERSARIAL_MARKDOWN'
export const HOSTED_ADVERSARIAL_HTML_MARKER = 'ORCA_ADVERSARIAL_HTML'
export const HOSTED_ADVERSARIAL_SVG_MARKER = 'ORCA_ADVERSARIAL_SVG'
export const HOSTED_ADVERSARIAL_IMAGE_MARKER = 'ORCA_ADVERSARIAL_IMAGE'

export async function createHostedAdversarialRepositoryFixture({ probePort } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), fixturePrefix)))
  try {
    await git(root, ['init', '-q'])
    await git(root, ['config', 'user.name', 'Orca Mobile Test'])
    await git(root, ['config', 'user.email', 'mobile-test@orca.invalid'])
    await writeFile(path.join(root, 'README.md'), 'Adversarial mobile fixture\n')
    const repositoryFiles = hostedAdversarialRepositoryFiles(probePort)
    for (const file of repositoryFiles) {
      await writeFile(path.join(root, file.filename), file.content)
    }
    const blobSource = path.join(root, '.orca-adversarial-content')
    await writeFile(blobSource, `${HOSTED_ADVERSARIAL_CONTENT}\n`)
    const blob = await git(root, ['hash-object', '-w', blobSource])
    await rm(blobSource)
    await git(root, ['add', 'README.md', ...repositoryFiles.map(({ filename }) => filename)])
    await git(root, [
      'update-index',
      '--add',
      '--cacheinfo',
      '100644',
      blob,
      HOSTED_ADVERSARIAL_FILENAME
    ])
    await git(root, ['commit', '-q', '-m', 'Initial fixture'])
    await git(root, ['branch', '-m', HOSTED_ADVERSARIAL_WORKSPACE_ROW])
    return {
      root,
      workspaceName: path.basename(root),
      workspaceRowName: HOSTED_ADVERSARIAL_WORKSPACE_ROW,
      filename: HOSTED_ADVERSARIAL_FILENAME,
      content: HOSTED_ADVERSARIAL_CONTENT,
      repositoryFiles
    }
  } catch (error) {
    await removeHostedAdversarialRepositoryFixture({ root })
    throw error
  }
}

export async function removeHostedAdversarialRepositoryFixture(fixture) {
  if (!fixture?.root || path.basename(fixture.root).startsWith(fixturePrefix) === false) {
    throw new Error('Refusing to remove an invalid adversarial repository fixture')
  }
  await rm(fixture.root, { recursive: true, force: true })
}

export async function readHostedAdversarialRepositoryContent(fixture) {
  return `${await git(fixture.root, ['show', `HEAD:${fixture.filename}`])}\n`
}

async function git(cwd, args) {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 30_000
  })
  return stdout.trim()
}

function hostedAdversarialRepositoryFiles(probePort) {
  const probeOrigin = `http://127.0.0.1:${probePort ?? 9}`
  return [
    {
      filename: HOSTED_ADVERSARIAL_MARKDOWN_FILENAME,
      marker: HOSTED_ADVERSARIAL_MARKDOWN_MARKER,
      content: `# \`${HOSTED_ADVERSARIAL_MARKDOWN_MARKER}\`

<img data-orca-adversarial="markdown" alt="${HOSTED_ADVERSARIAL_MARKDOWN_MARKER}" src="${probeOrigin}/markdown-image" onerror="globalThis.${HOSTED_ADVERSARIAL_MARKDOWN_MARKER}=1">
<svg data-orca-adversarial="markdown-svg" onload="globalThis.${HOSTED_ADVERSARIAL_MARKDOWN_MARKER}=1"><foreignObject>unsafe</foreignObject></svg>
[active](javascript:globalThis.${HOSTED_ADVERSARIAL_MARKDOWN_MARKER}=1)
![network](${probeOrigin}/markdown-link)
`
    },
    {
      filename: HOSTED_ADVERSARIAL_HTML_FILENAME,
      marker: HOSTED_ADVERSARIAL_HTML_MARKER,
      content: `<section data-orca-adversarial="html"><p>${HOSTED_ADVERSARIAL_HTML_MARKER}</p><img src="${probeOrigin}/html-image" onerror="globalThis.${HOSTED_ADVERSARIAL_HTML_MARKER}=1"><svg onload="globalThis.${HOSTED_ADVERSARIAL_HTML_MARKER}=1"><foreignObject>unsafe</foreignObject></svg><script>globalThis.${HOSTED_ADVERSARIAL_HTML_MARKER}=1</script></section>\n`
    },
    {
      filename: HOSTED_ADVERSARIAL_SVG_FILENAME,
      marker: HOSTED_ADVERSARIAL_SVG_MARKER,
      content: `<svg data-orca-adversarial="svg" xmlns="http://www.w3.org/2000/svg" onload="globalThis.${HOSTED_ADVERSARIAL_SVG_MARKER}=1"><text>${HOSTED_ADVERSARIAL_SVG_MARKER}</text><image href="${probeOrigin}/svg-image" onerror="globalThis.${HOSTED_ADVERSARIAL_SVG_MARKER}=1"/><foreignObject><script>globalThis.${HOSTED_ADVERSARIAL_SVG_MARKER}=1</script></foreignObject></svg>\n`
    },
    {
      filename: HOSTED_ADVERSARIAL_IMAGE_FILENAME,
      marker: HOSTED_ADVERSARIAL_IMAGE_MARKER,
      content: hostedAdversarialPng(probeOrigin)
    }
  ]
}

function hostedAdversarialPng(probeOrigin) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1, 0)
  ihdr.writeUInt32BE(1, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const metadata = Buffer.from(
    `Comment\0<img src="${probeOrigin}/png-metadata" onerror="globalThis.${HOSTED_ADVERSARIAL_IMAGE_MARKER}=1">`
  )
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', ihdr),
    pngChunk('tEXt', metadata),
    pngChunk('IDAT', deflateSync(Buffer.from([0, 70, 120, 190, 255]))),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])))
  return Buffer.concat([length, typeBytes, data, checksum])
}

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}
