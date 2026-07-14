import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const HASH_RE = /^[0-9a-f]{64}$/

export function putBlob(blobDir: string, bytes: Buffer): string {
  const hash = createHash('sha256').update(bytes).digest('hex')
  const dir = join(blobDir, hash.slice(0, 2))
  const dest = join(dir, hash)
  if (existsSync(dest)) {
    return hash // content-addressed: 동일 바이트면 재저장 불필요.
  }
  mkdirSync(dir, { recursive: true })
  // 원자적 쓰기: 임시 파일 → rename(부분 파일 노출 방지).
  const tmp = join(dir, `.${randomUUID()}.tmp`)
  writeFileSync(tmp, bytes)
  renameSync(tmp, dest)
  return hash
}

export function blobPath(blobDir: string, hash: string): string | null {
  // 64-hex만 허용 — 임의 hash로 blob 디렉토리 밖을 못 읽게 한다.
  if (!HASH_RE.test(hash)) {
    return null
  }
  return join(blobDir, hash.slice(0, 2), hash)
}

export function readBlob(blobDir: string, hash: string): Buffer | null {
  const p = blobPath(blobDir, hash)
  if (!p || !existsSync(p)) {
    return null
  }
  return readFileSync(p)
}
