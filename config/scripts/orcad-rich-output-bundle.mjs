import { cp, rm } from 'node:fs/promises'
import { withClaudeRichOutputBuildLock } from './claude-rich-output-build-lock.mjs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CLAUDE_RICH_OUTPUT_MANIFEST,
  claudeRichOutputAssetFilenames
} from '../../src/shared/claude-rich-output-artifacts.ts'

export function readOrcadRichOutputAssetFilenames(directory) {
  return claudeRichOutputAssetFilenames(
    readFileSync(join(directory, CLAUDE_RICH_OUTPUT_MANIFEST), 'utf8')
  )
}

export async function stageOrcadRichOutput(root, outputDir) {
  await withClaudeRichOutputBuildLock(root, async (assertLockHeld) => {
    const destination = join(outputDir, 'claude-rich-output')
    await rm(destination, { recursive: true, force: true })
    assertLockHeld()
    await cp(join(root, 'out', 'claude-rich-output'), destination, { recursive: true })
    assertLockHeld()
    readOrcadRichOutputAssetFilenames(outputDir)
  })
}
