import {
  isolatedScanRoots,
  writeJcodeSessionFixture,
  writeMuseScannerFixture,
  writeOpenCode2SqliteFixture
} from './session-scanner-test-fixtures'
import { writeKiroSessionFixture } from './session-scanner-kiro-fixtures'
import { writeDocumentAgentFixtures } from './session-scanner-document-agent-fixtures'
import { writeLogAgentFixtures } from './session-scanner-log-agent-fixtures'
import { writeOpenCodeSqliteDatabase } from './session-scanner-opencode-sqlite-fixture'

export type EveryAgentVault = {
  roots: ReturnType<typeof isolatedScanRoots>
  antigravitySessionId: string
  ompSessionFile: string
  primeAgentSessionFile: string
}

/** Build all agent layouts; OpenCode uses legacy JSON here and a separate fixture for SQLite. */
export async function writeEveryAgentVault(root: string): Promise<EveryAgentVault> {
  const roots = isolatedScanRoots(root)
  const antigravitySessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  const { ompSessionFile, primeAgentSessionFile } = await writeLogAgentFixtures(roots)
  await writeDocumentAgentFixtures(root, roots, antigravitySessionId)
  await writeMuseScannerFixture(roots.museSessionsDir)
  await writeJcodeSessionFixture(roots)
  await writeKiroSessionFixture(roots)
  roots.opencodeDbPaths = [await writeOpenCode2SqliteFixture(root)]
  writeOpenCodeSqliteDatabase(roots.zcodeDbPath, [
    {
      id: 'zcode-session',
      directory: '/tmp/zcode',
      title: 'ZCode title',
      turns: [{ role: 'user', parts: ['ZCode session prompt'] }]
    }
  ])
  return { roots, antigravitySessionId, ompSessionFile, primeAgentSessionFile }
}
