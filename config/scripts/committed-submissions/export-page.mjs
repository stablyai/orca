import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
  verify
} from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const maxBytes = 16 * 1024 * 1024

function syncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY)
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function assertOwned(path, directory = false, privateKey = false) {
  const stat = lstatSync(path)
  if (
    realpathSync(path) !== resolve(path) ||
    stat.uid !== process.getuid() ||
    (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
    stat.mode & (privateKey ? 0o077 : 0o022)
  ) {
    throw new Error('export resource ownership or permissions are invalid')
  }
}

export function exportPage({ database, directory, key, after = 0, limit = 32 }) {
  if (
    !Number.isSafeInteger(after) ||
    after < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 64
  ) {
    throw new Error('invalid export page')
  }
  assertOwned(database)
  assertOwned(directory, true)
  assertOwned(key, false, true)
  const privateKey = createPrivateKey(readFileSync(key))
  const publicKey = createPublicKey(privateKey)
  if (publicKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1')
    throw new Error('expected a P-256 signing key')
  const keyId = digest(publicKey.export({ type: 'spki', format: 'der' }))
  const db = new DatabaseSync(database, { readOnly: true })
  let last = after
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; BEGIN')
    const enrollment = db.prepare('SELECT * FROM journal_export_enrollment WHERE singleton=1').get()
    if (enrollment?.schema_version !== 1) throw new Error('journal is not enrolled for export v1')
    const read = db.prepare(
      'SELECT * FROM journal_submission_export WHERE cursor>? ORDER BY cursor LIMIT 1'
    )
    const blob = db.prepare(
      'SELECT content FROM journal_export_blobs WHERE digest=? AND length(content)=?'
    )
    for (let index = 0; index < limit; index++) {
      const row = read.get(last)
      if (!row) break
      if (
        row.cursor !== last + 1 ||
        row.bot_id !== enrollment.bot_id ||
        row.writer_epoch !== enrollment.writer_epoch
      ) {
        throw new Error('export stream identity or continuity mismatch')
      }
      const original = JSON.parse(row.original_json)
      const provenance = JSON.parse(row.provenance_json)
      let remaining =
        maxBytes - Buffer.byteLength(row.original_json) - Buffer.byteLength(row.provenance_json)
      const attachments = JSON.parse(row.attachments_json).map((ref) => {
        if (!Number.isSafeInteger(ref.size) || ref.size < 0 || ref.size > remaining)
          throw new Error('invalid export attachment size')
        const bytes = blob.get(ref.sha256, ref.size)?.content
        if (!bytes || digest(bytes) !== ref.sha256) throw new Error('attachment digest mismatch')
        remaining -= ref.size
        return { ...ref, bytes: Buffer.from(bytes).toString('base64') }
      })
      if (remaining < 0) throw new Error('oversized export')
      const content = Buffer.from(
        JSON.stringify({
          version: 1,
          eventId: row.event_id,
          botId: row.bot_id,
          writerEpoch: row.writer_epoch,
          cursor: row.cursor,
          chatId: row.session_id,
          chatEpoch: row.epoch,
          journalSequence: row.journal_sequence,
          sourceId: row.source_id,
          sourceKind: row.source_kind,
          committedAt: row.committed_at,
          predecessor: row.predecessor,
          original,
          provenance,
          attachments
        })
      )
      const path = join(directory, String(row.cursor) + '.json')
      if (existsSync(path)) {
        const prior = JSON.parse(readFileSync(path, 'utf8'))
        if (
          prior.payload !== content.toString('base64') ||
          prior.keyId !== keyId ||
          !verify('sha256', content, publicKey, Buffer.from(prior.signature, 'base64'))
        ) {
          throw new Error('conflicting immutable delivery')
        }
      } else {
        const data = JSON.stringify({
          keyId,
          payload: content.toString('base64'),
          signature: sign('sha256', content, privateKey).toString('base64')
        })
        const tmp = path + '.' + randomUUID() + '.tmp'
        const fd = openSync(tmp, 'wx', 0o640)
        try {
          writeFileSync(fd, data)
          fsyncSync(fd)
          linkSync(tmp, path)
          syncDirectory(directory)
        } finally {
          closeSync(fd)
          unlinkSync(tmp)
        }
      }
      last = row.cursor
    }
    return { after, through: last }
  } finally {
    db.close()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [database, directory, key, after, limit] = process.argv.slice(2)
  try {
    console.log(
      JSON.stringify(
        exportPage({
          database,
          directory,
          key,
          after: Number(after ?? 0),
          limit: Number(limit ?? 32)
        })
      )
    )
  } catch {
    console.error('Committed submission export failed; the cursor was not acknowledged.')
    process.exitCode = 1
  }
}
