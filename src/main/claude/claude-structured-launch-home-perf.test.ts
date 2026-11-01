import * as nativeFs from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterEach, expect, it, vi } from 'vitest'
import { ClaudeProfileRouter } from '../claude-accounts/claude-profile-router'
import { claudeLaunchResumesTranscript } from './claude-structured-launch-home'

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof fs>()
  return { ...actual, readdir: vi.fn(actual.readdir) }
})
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof nativeFs>()
  return { ...actual, readdirSync: vi.fn(actual.readdirSync) }
})

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

it.each([10, 100])(
  'bounds saved-home transcript traversal with %i project directories',
  async (directories) => {
    const root = await fs.mkdtemp(join(tmpdir(), 'claude-saved-transcript-perf-'))
    roots.push(root)
    const router = new ClaudeProfileRouter({
      dataRoot: root,
      userHome: join(root, 'personal'),
      env: {},
      getSettings: () => ({
        claudeManagedAccounts: [],
        activeClaudeManagedAccountId: 'selected',
        activeClaudeManagedAccountIdsByRuntime: undefined,
        agentStatusHooksEnabled: false,
        disabledTuiAgents: []
      })
    })
    const selectedHome = router.accountHome('selected')
    const selectedProject = join(selectedHome, 'projects', '-repos-selected')
    const savedHome = join(root, 'custom-home')
    const savedProjects = join(savedHome, 'projects')
    await fs.mkdir(selectedProject, { recursive: true })
    await fs.mkdir(join(router.systemDefaultHome(), 'projects'), { recursive: true })
    for (let index = 0; index < directories; index += 1) {
      const project = join(savedProjects, `-repos-${index}`)
      await fs.mkdir(project, { recursive: true })
      await fs.writeFile(join(project, `unrelated-${index}.jsonl`), '{}\n')
    }
    const accountListings = vi.mocked(nativeFs.readdirSync)
    const readdir = vi.mocked(fs.readdir)
    async function observe(
      phase: string,
      providerSessionId: string,
      refuses = false,
      recordHome = savedHome
    ) {
      readdir.mockClear()
      accountListings.mockClear()
      const started = performance.now()
      const outcome = await claudeLaunchResumesTranscript({
        router,
        providerSessionId,
        leafUuid: 'known-leaf',
        claudeConfigDir: selectedHome,
        recordHome
      }).then(
        (result) => ({ result }),
        (error: unknown) => ({ error })
      )
      const elapsedMs = performance.now() - started
      const paths = readdir.mock.calls.map(([path]) => String(path))
      const recordProjects = join(recordHome, 'projects')
      const counts = {
        enumerations: paths.length,
        savedEnumerations: paths.filter(
          (path) => path === recordProjects || path.startsWith(`${recordProjects}${sep}`)
        ).length,
        accountListings: accountListings.mock.calls.length
      }
      if (refuses) {
        expect(outcome).toMatchObject({
          error: { name: 'AgentSessionPreSpawnError', reason: 'historyInOtherAccount' }
        })
      } else {
        expect(outcome).toEqual({ result: true })
      }
      console.info('saved-home-transcript-perf', { phase, directories, ...counts, elapsedMs })
      return counts
    }

    await fs.writeFile(join(selectedProject, 'selected-hit.jsonl'), '{}\n')
    expect(await observe('selected-hit', 'selected-hit')).toEqual({
      enumerations: 2,
      savedEnumerations: 0,
      accountListings: 0
    })
    // A saved home also listed as an account is traversed twice on a miss.
    const listedHome = router.accountHome('saved')
    await fs.mkdir(dirname(listedHome), { recursive: true })
    await fs.rename(savedHome, listedHome)
    expect(await observe('total-miss', 'absent-session', false, listedHome)).toEqual({
      enumerations: 2 * directories + 5,
      savedEnumerations: 2 * (directories + 1),
      accountListings: 1
    })
    await fs.rename(listedHome, savedHome)
    await fs.writeFile(
      join(savedProjects, `-repos-${directories - 1}`, 'saved-source.jsonl'),
      '{}\n'
    )
    expect(await observe('saved-source-refusal', 'saved-source', true)).toEqual({
      enumerations: directories + 3,
      savedEnumerations: directories + 1,
      accountListings: 1
    })
    await fs.writeFile(join(selectedProject, 'saved-source.jsonl'), '{}\n')
    expect(await observe('selected-recovery', 'saved-source')).toEqual({
      enumerations: 2,
      savedEnumerations: 0,
      accountListings: 0
    })
  }
)
