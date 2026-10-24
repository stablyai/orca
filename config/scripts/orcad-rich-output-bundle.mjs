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
