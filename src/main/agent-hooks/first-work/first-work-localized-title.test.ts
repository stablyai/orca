import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { hostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import { gitExecFileAsync } from '../../git/command-runner/git-exec-file'
import {
  closeTestStores,
  createStore,
  makeRepo,
  testState
} from '../../persistence/persistence-test-harness'
import { firstWorkRenameDeps } from './first-work-rename-runtime'
import {
  maybeAutoRenameBranchOnFirstWork,
  resetFirstWorkBranchRenameState
} from './first-work-branch-rename'

let folder: string

beforeEach(async () => {
  folder = mkdtempSync(join(tmpdir(), 'orca-localized-title-'))
  testState.dir = join(folder, 'profile')
  resetFirstWorkBranchRenameState()
  await git(['init'])
  await git(['symbolic-ref', 'HEAD', 'refs/heads/nautilus'])
  await git(['config', 'user.username', 'orca-test'])
  await git([
    '-c',
    'user.name=Orca Test',
    '-c',
    'user.email=orca@example.invalid',
    'commit',
    '--allow-empty',
    '-m',
    'Initial fixture'
  ])
})

afterEach(async () => {
  await closeTestStores()
  rmSync(folder, { recursive: true, force: true })
})

function git(args: string[]) {
  return gitExecFileAsync(args, { cwd: folder })
}

async function startFirstTask(
  output: string,
  pending: boolean,
  displayName: string,
  beforeGeneration?: (store: ReturnType<typeof createStore>, worktreeId: string) => Promise<void>
) {
  const agent = join(folder, 'naming-agent.cjs')
  writeFileSync(
    agent,
    `process.stdin.resume(); process.stdin.on('end', () => console.log(${JSON.stringify(output)}))`
  )
  const store = createStore()
  store.updateSettings({
    autoRenameBranchFromWork: true,
    branchPrefix: 'none',
    workspaceTitleLanguage: 'zh',
    sourceControlAi: {
      enabled: true,
      agentId: 'custom',
      selectedModelByAgent: {},
      selectedThinkingByModel: {},
      customAgentCommand: `"${process.execPath}" "${agent}"`,
      instructionsByOperation: {}
    }
  })
  const repo = makeRepo({ path: folder })
  store.addRepo(repo)
  const worktreeId = `${repo.id}::${folder}`
  store.setWorktreeMeta(hostWorktreeTarget({ id: worktreeId, hostId: 'local' }), {
    displayName,
    pendingFirstAgentMessageRename: pending,
    orcaCreationSource: 'runtime'
  })
  await maybeAutoRenameBranchOnFirstWork(
    {
      paneKey: 'tab:leaf',
      worktreeId,
      tabId: undefined,
      state: 'working',
      prompt: '修复登录',
      assistantMessage: undefined,
      isReplay: false
    },
    firstWorkRenameDeps(store, {
      getCommitMessageAgentEnvironmentResolvers: () =>
        beforeGeneration
          ? {
              resolveBaseEnvironment: async () => {
                await beforeGeneration(store, worktreeId)
                return { PATH: process.env.PATH ?? '' }
              }
            }
          : undefined,
      notifyFolderWorkspaceChanged: () => {},
      notifyBranchRenamed: () => {},
      notifyWorktreeFolderRenamed: () => {}
    })
  )
  return store.getWorktreeMeta(worktreeId)
}

it('applies the first-task title when the generated branch is already selected', async () => {
  const meta = await startFirstTask('{"branch":"nautilus","title":"修复登录"}', true, 'Nautilus')

  expect(meta).toMatchObject({ displayName: '修复登录', pendingFirstAgentMessageRename: false })
  expect((await git(['branch', '--show-current'])).stdout.trim()).toBe('nautilus')
})

it('renames the branch without requiring a title for a manually named workspace', async () => {
  const meta = await startFirstTask('fix-login', false, '手动标题')

  expect((await git(['branch', '--show-current'])).stdout.trim()).toBe('fix-login')
  expect(meta).toMatchObject({ displayName: '手动标题', pendingFirstAgentMessageRename: false })
})

it('finishes the pending title when branch selection changes during naming', async () => {
  const meta = await startFirstTask(
    '{"branch":"fix-login","title":"修复登录"}',
    true,
    'Nautilus',
    async (store, worktreeId) => {
      await git(['switch', '-c', 'chosen-branch'])
      store.setWorktreeMeta(hostWorktreeTarget({ id: worktreeId, hostId: 'local' }), {
        branchNameIsUserChosen: true
      })
    }
  )

  expect(meta).toMatchObject({ displayName: '修复登录', pendingFirstAgentMessageRename: false })
  expect((await git(['branch', '--show-current'])).stdout.trim()).toBe('chosen-branch')
})
