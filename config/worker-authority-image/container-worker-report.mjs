#!/usr/bin/env node

import { closeSync, fsyncSync, linkSync, openSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

const MAX_SUBJECT_BYTES = 512
const MAX_BODY_BYTES = 64 * 1024
const fields = new Map()

for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index]
  const value = process.argv[index + 1]
  if (!key?.startsWith('--') || value === undefined) {
    throw new Error(
      'usage: orca-worker-report --type <worker_done|escalation> --subject <text> --body <text> [--outcome <succeeded|failed>]'
    )
  }
  fields.set(key.slice(2), value)
}

const type = fields.get('type')
const outcome = fields.get('outcome')
const subject = fields.get('subject')
const body = fields.get('body')
const dispatchId = process.env.ORCA_DISPATCH_ID
const lifecycleBinding = process.env.ORCA_LIFECYCLE_BINDING
const lifecycleDir = process.env.ORCA_LIFECYCLE_DIR

if (
  !dispatchId ||
  !lifecycleBinding ||
  !lifecycleDir ||
  (type !== 'worker_done' && type !== 'escalation') ||
  !subject ||
  body === undefined ||
  Buffer.byteLength(subject) > MAX_SUBJECT_BYTES ||
  Buffer.byteLength(body) > MAX_BODY_BYTES ||
  (type === 'worker_done' && outcome !== 'succeeded' && outcome !== 'failed') ||
  (type === 'escalation' && outcome !== undefined)
) {
  throw new Error('invalid lifecycle report')
}

const receipt = {
  schemaVersion: 'worker_lifecycle_receipt/1',
  dispatchId,
  lifecycleBinding,
  type,
  subject,
  body,
  ...(outcome ? { outcome } : {})
}
const path = join(lifecycleDir, 'result.json')
const stagingPath = join(lifecycleDir, `.result-${process.pid}-${randomUUID()}.tmp`)
const fd = openSync(stagingPath, 'wx', 0o600)
try {
  writeFileSync(fd, `${JSON.stringify(receipt)}\n`, 'utf8')
  fsyncSync(fd)
} finally {
  closeSync(fd)
}
try {
  linkSync(stagingPath, path)
} finally {
  unlinkSync(stagingPath)
}
