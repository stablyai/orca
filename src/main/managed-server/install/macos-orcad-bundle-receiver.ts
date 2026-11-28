import { createHash } from 'node:crypto'
import { quotePosixShell } from '../../../shared/shell/launch/shell-argument-quoting'

// The pinned host Node reads the digest-checked manifest followed by exactly each missing file's bytes.
const receiveBundle = `
import * as fs from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
const [length, digest, stage] = process.argv.slice(1)
function readExactly(buffer) {
  let offset = 0
  while (offset < buffer.length) {
    const n = fs.readSync(0, buffer, offset, buffer.length - offset, null)
    if (!n) throw Error('Orca server upload ended early')
    offset += n
  }
}
const header = Buffer.alloc(Number(length))
readExactly(header)
if (createHash('sha256').update(header).digest('hex') !== digest) throw Error('Invalid Orca upload manifest')
const files = JSON.parse(header.toString('utf8'))
const root = stage ? dirname(process.cwd()) : process.cwd()
const parents = new Set([root])
function directory(path) {
  if (parents.has(path)) return
  directory(dirname(path))
  const stat = fs.lstatSync(path, { throwIfNoEntry: false })
  if (stat && !stat.isDirectory()) throw Error('Unsafe install directory: ' + path)
  if (!stat && stage) fs.mkdirSync(path)
  parents.add(path)
}
const part = stage && join(stage, 'part')
const buffer = Buffer.alloc(128 * 1024)
let matches = ''
for (const { filename, size, sha256, executable } of files) {
  const target = join(root, filename)
  if (!target.startsWith(root + '/')) throw Error('Invalid Orca upload path: ' + filename)
  directory(dirname(target))
  const dest = fs.lstatSync(target, { throwIfNoEntry: false })
  if (dest && !dest.isFile()) throw Error('Unsafe install target: ' + target)
  if (part) {
    const fd = fs.openSync(part, 'wx', 0o600)
    try {
      for (let left = size; left > 0;) {
        const bytes = buffer.subarray(0, Math.min(left, buffer.length))
        readExactly(bytes)
        fs.writeFileSync(fd, bytes)
        left -= bytes.length
      }
    } finally {
      fs.closeSync(fd)
    }
  }
  let match = false
  if (part || dest?.size === size) {
    const hash = createHash('sha256')
    for await (const bytes of fs.createReadStream(part || target)) hash.update(bytes)
    match = hash.digest('hex') === sha256
  }
  if (part && !match) throw Error('Orca upload checksum mismatch: ' + filename)
  if (match && executable && (part || (dest.mode & 0o111) !== 0o111)) fs.chmodSync(part || target, 0o755)
  if (part) fs.renameSync(part, target)
  matches += match ? '1' : '0'
}
console.log(stage ? 'OK' : matches)
`

export function macOrcadReceiverCommand(node: string, header: Buffer): string {
  const digest = createHash('sha256').update(header).digest('hex')
  return `${quotePosixShell(node)} --input-type=module -e ${quotePosixShell(receiveBundle)} ${header.length} ${digest}`
}
