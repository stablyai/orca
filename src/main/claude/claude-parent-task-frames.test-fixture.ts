// CLI 2.1.319, isolated real run: parent Stop, live child roster, then separate child Stop; IDs/paths sanitized.
import { readFileSync } from 'node:fs'
import type { CapturedFrame } from './claude-captured-frame-builders.test-fixture'

export const PARENT_TASK_STOP: CapturedFrame[] = readFileSync(
  new URL('./__fixtures__/claude-parent-task-stop-2.1.319.jsonl', import.meta.url),
  'utf8'
)
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))
