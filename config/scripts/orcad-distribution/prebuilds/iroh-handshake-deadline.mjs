import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PATCH_BYTES = readFileSync(new URL('./iroh-accepting-connect.rs', import.meta.url))
export const IROH_HANDSHAKE_PATCH_SHA256 = createHash('sha256').update(PATCH_BYTES).digest('hex')

const ORIGINAL = `impl Accepting {
    #[napi]
    pub async fn connect(&self) -> Result<Connection> {
        let inner = self
            .0
            .lock()
            .await
            .take()
            .ok_or_else(|| anyhow::anyhow!("Accepting already consumed"))?;
        let conn = inner.await.map_err(|e| anyhow::anyhow!("{e:?}"))?;
        Ok(Connection(Arc::new(conn)))
    }
`

/** Patch only the reviewed SDK method, rejecting drift instead of building an unbounded handshake. */
export function applyIrohHandshakeDeadline(sourceDir) {
  const path = join(sourceDir, 'iroh-js', 'src', 'endpoint.rs')
  const source = readFileSync(path, 'utf8')
  const start = source.indexOf(ORIGINAL)
  if (start === -1 || source.includes(ORIGINAL, start + ORIGINAL.length)) {
    throw new Error(
      '[orcad-prebuilds] pinned SDK Accepting.connect source does not match the reviewed deadline patch'
    )
  }
  writeFileSync(
    path,
    `${source.slice(0, start)}impl Accepting {\n${PATCH_BYTES.toString('utf8')}${source.slice(start + ORIGINAL.length)}`
  )
}
