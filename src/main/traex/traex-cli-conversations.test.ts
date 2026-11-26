import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { TRAEX_CLI_CONVERSATIONS } from './traex-cli-conversations'

const id = '01a1493f-4ac5-7620-90cc-645caf0627bf'
const segment = '01a1493f-d937-70d2-8214-844aecb998b9'
let root: string | undefined

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
})

it('finds the newest segment of a paginated Trae conversation', async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-trae-transcript-'))
  const day = join(root, 'sessions', '2026', '10', '17')
  await mkdir(day, { recursive: true })
  const legacy = join(day, `rollout-2026-10-17T17-44-07-${id}.jsonl`)
  const latest = join(day, `rollout-2026-10-17T17-44-43-${id}_${segment}.jsonl`)
  await writeFile(legacy, '')
  await writeFile(latest, '')
  await utimes(legacy, new Date(1000), new Date(1000))
  await utimes(latest, new Date(2000), new Date(2000))

  const transcriptImport = TRAEX_CLI_CONVERSATIONS.transcriptImport
  if (!transcriptImport) {
    throw new Error('TRAE CLI transcript import is missing')
  }
  await expect(
    transcriptImport.findTranscript({
      providerSessionId: id,
      store: join(root, 'sessions'),
      launchEnv: {},
      workspaceCwd: root
    })
  ).resolves.toBe(latest)
})
