import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { installRealWorkerThreadChildProcesses } from '../../../worker-thread-child-process/worker-thread-child-process-real.test-fixtures'
import { installGitHubProjectAccounts } from '../../../github/accounts/github-project-account'
import { desktopGitHubCli, desktopRoute, git } from './desktop-ssh-git-execution.test-fixture'

let directory: string | undefined

afterEach(async () => {
  vi.unstubAllEnvs()
  if (directory) {
    await rm(directory, { recursive: true, force: true })
    directory = undefined
  }
})

it('pushes a sandbox-owned checkout using the desktop process environment', async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-desktop-git-'))
  const checkout = join(directory, 'checkout')
  const origin = join(directory, 'origin.git')
  const hooks = join(directory, 'hooks')
  await mkdir(checkout)
  await mkdir(hooks)
  await git(checkout, ['init', '-q'])
  await git(checkout, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  await git(checkout, ['config', 'user.name', 'Desktop Git'])
  await git(checkout, ['config', 'user.email', 'desktop@example.test'])
  await git(checkout, ['config', 'commit.gpgsign', 'false'])
  await git(checkout, ['commit', '--allow-empty', '-qm', 'desktop push commit'])
  await git(checkout, ['init', '--bare', '-q', origin])
  await git(checkout, ['remote', 'add', 'origin', origin])
  await git(checkout, ['config', 'core.hooksPath', hooks])
  await writeFile(
    join(hooks, 'pre-push'),
    '#!/bin/sh\n[ "$ORCA_TEST_DESKTOP_GIT" = "available" ] || exit 1\n',
    { mode: 0o755 }
  )
  vi.stubEnv('ORCA_TEST_DESKTOP_GIT', 'available')
  const push = desktopRoute(checkout, { gitExecutionProjects: { [checkout]: 'local' } })

  expect(await push()).toMatchObject({ ok: true, _meta: { runtimeId: 'sandbox-runtime' } })

  expect(await git(origin, ['show', '-s', '--format=%s', 'refs/heads/main'])).toBe(
    'desktop push commit'
  )
})

it('leaves Git on the SSH host until local execution is enabled', async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-desktop-git-scope-'))
  const push = desktopRoute(directory, {})

  expect(await push()).toBeNull()
})

it('lets a project keep SSH execution when its host defaults to this computer', async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-desktop-git-override-'))
  const push = desktopRoute(directory, {
    gitExecution: 'local',
    gitExecutionProjects: { [directory]: 'remote' }
  })

  expect(await push()).toBeNull()
})

it('reports an unavailable local checkout without pushing from the sandbox', async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-desktop-git-missing-'))
  const checkout = join(directory, 'not-mounted')
  const push = desktopRoute(checkout, { gitExecution: 'local' })

  expect(await push()).toMatchObject({
    ok: false,
    error: {
      code: 'runtime_error'
    }
  })
})

it('runs a GitHub comment mutation with the desktop GitHub credentials', async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-desktop-gh-'))
  const cli = await desktopGitHubCli(
    directory,
    `
const args = process.argv.slice(2)
require('node:fs').writeFileSync(process.env.ORCA_TEST_GH_LOG, JSON.stringify({
  endpoint: args.find(arg => arg.startsWith('repos/')),
  body: args[args.indexOf('--raw-field') + 1],
  token: process.env.GH_TOKEN
}))
process.stdout.write(JSON.stringify({ id: 91, body: 'From desktop', user: { login: 'desktop' }, created_at: '2026-11-16T10:00:00Z', html_url: 'https://github.com/acme/widgets/issues/42#issuecomment-91' }))
`
  )
  try {
    const request = desktopRoute(directory, { gitExecution: 'local' })

    expect(
      await request({
        method: 'github.project.addIssueCommentBySlug',
        params: { owner: 'acme', repo: 'widgets', number: 42, body: 'From desktop' }
      })
    ).toMatchObject({ ok: true, result: { ok: true, comment: { id: 91 } } })

    expect(JSON.parse(await readFile(cli.mutationLog, 'utf8'))).toEqual({
      endpoint: 'repos/acme/widgets/issues/42/comments',
      body: 'body=From desktop',
      token: 'desktop-gh-token'
    })

    const projectRequest = desktopRoute(directory, {
      gitExecutionProjects: { [directory]: 'local' }
    })
    expect(
      await projectRequest({
        method: 'github.project.addIssueCommentBySlug',
        params: {
          owner: 'acme',
          repo: 'widgets',
          number: 42,
          body: 'From project desktop',
          gitExecutionRepo: 'id:sandbox-project'
        }
      })
    ).toMatchObject({ ok: true, result: { ok: true, comment: { id: 91 } } })
    expect(JSON.parse(await readFile(cli.mutationLog, 'utf8'))).toEqual({
      endpoint: 'repos/acme/widgets/issues/42/comments',
      body: 'body=From project desktop',
      token: 'desktop-gh-token'
    })
  } finally {
    await cli.dispose()
  }
})

it('uses ambient desktop credentials despite sandbox and desktop project account bindings', async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-desktop-gh-bound-'))
  await git(directory, ['init', '-q'])
  const release = installGitHubProjectAccounts({
    getRepos: () => [
      {
        id: 'desktop-project',
        path: directory!,
        displayName: 'Desktop project',
        badgeColor: '',
        addedAt: 0,
        ghAccount: { host: 'github.com', user: 'different-desktop-account' }
      }
    ]
  })
  const cli = await desktopGitHubCli(
    directory,
    `
const args = process.argv.slice(2)
if (args[0] === 'auth') process.exit(1)
require('node:fs').writeFileSync(process.env.ORCA_TEST_GH_LOG, JSON.stringify({
  endpoint: args.find(arg => arg.startsWith('repos/')),
  token: process.env.GH_TOKEN
}))
process.stdout.write('desktop-label\\n')
`
  )
  try {
    const request = desktopRoute(directory, { gitExecution: 'local' })
    expect(
      await request({
        method: 'github.listLabels',
        params: {
          repo: 'id:sandbox-project',
          ownerRepo: { owner: 'acme', repo: 'widgets', host: 'github.com' },
          expectedGhAccount: { host: 'github.com', user: 'sandbox-account' }
        }
      })
    ).toMatchObject({ ok: true, result: ['desktop-label'] })
    expect(JSON.parse(await readFile(cli.mutationLog, 'utf8'))).toEqual({
      endpoint: 'repos/acme/widgets/labels',
      token: 'desktop-gh-token'
    })
  } finally {
    release()
    await cli.dispose()
  }
})

it('resolves an Orca repository before reading its explicitly named GitHub issue', async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-desktop-gh-owned-'))
  await git(directory, ['init', '-q'])
  await git(directory, ['remote', 'add', 'origin', 'https://github.com/acme/widgets.git'])
  const cli = await desktopGitHubCli(
    directory,
    `
const args = process.argv.slice(2)
require('node:fs').writeFileSync(process.env.ORCA_TEST_GH_LOG, JSON.stringify({
  endpoint: args.find(arg => arg.startsWith('repos/')),
  token: process.env.GH_TOKEN
}))
process.stdout.write(JSON.stringify({ number: 42, title: 'Desktop issue', state: 'open', html_url: 'https://github.com/acme/widgets/issues/42' }))
`
  )
  try {
    const request = desktopRoute(directory, { gitExecutionProjects: { [directory]: 'local' } })
    expect(
      await request({
        method: 'github.workItemByOwnerRepo',
        params: {
          repo: 'id:sandbox-project',
          owner: 'acme',
          ownerRepo: 'widgets',
          host: 'github.com',
          number: 42,
          type: 'issue'
        }
      })
    ).toMatchObject({ ok: true, result: { number: 42, title: 'Desktop issue' } })
    expect(JSON.parse(await readFile(cli.mutationLog, 'utf8'))).toEqual({
      endpoint: 'repos/acme/widgets/issues/42',
      token: 'desktop-gh-token'
    })
  } finally {
    await cli.dispose()
  }
})

it.each(['host', 'project'])(
  'stages and uploads GitHub images using the desktop %s policy',
  async (scope) => {
    directory = await mkdtemp(join(tmpdir(), 'orca-desktop-gh-image-'))
    const cli = await desktopGitHubCli(
      directory,
      `
const fs = require('node:fs')
if (process.argv.includes('POST')) {
  fs.writeFileSync(process.env.ORCA_TEST_GH_LOG, JSON.stringify({
    bytes: Array.from(fs.readFileSync(0)),
    token: process.env.GH_TOKEN
  }))
  process.stdout.write(JSON.stringify({ url: 'https://github.com/user-attachments/assets/desktop-image' }))
} else {
  process.stdout.write(JSON.stringify({ id: 123 }))
}
`
    )
    try {
      const request = desktopRoute(
        directory,
        scope === 'host'
          ? { gitExecution: 'local' }
          : { gitExecution: 'remote', gitExecutionProjects: { [directory]: 'local' } }
      )
      const projectHint = scope === 'project' ? { gitExecutionRepo: 'id:sandbox-project' } : {}
      const target = { kind: 'slug', owner: 'acme', repo: 'widgets' }
      const started = await request({
        method: 'clipboard.startImageUpload',
        params: { expectedBase64Length: 12, gitExecutionTarget: target, ...projectHint }
      })
      if (
        !started?.ok ||
        !started.result ||
        typeof started.result !== 'object' ||
        !('uploadId' in started.result)
      ) {
        throw new Error(`Image staging failed: ${JSON.stringify(started)}`)
      }
      const uploadId = started.result.uploadId
      expect(
        await request({
          method: 'clipboard.appendImageUploadChunk',
          params: {
            uploadId,
            offset: 0,
            contentBase64: 'iVBORw0KGgo=',
            gitExecutionTarget: target,
            ...projectHint
          }
        })
      ).toMatchObject({ ok: true })

      expect(
        await request({
          method: 'github.uploadAttachment',
          params: {
            uploadId,
            target,
            fileName: 'image.png',
            contentType: 'image/png',
            ...projectHint
          }
        })
      ).toMatchObject({
        ok: true,
        result: { url: 'https://github.com/user-attachments/assets/desktop-image' }
      })
      expect(JSON.parse(await readFile(cli.mutationLog, 'utf8'))).toEqual({
        bytes: [137, 80, 78, 71, 13, 10, 26, 10],
        token: 'desktop-gh-token'
      })
    } finally {
      await cli.dispose()
    }
  }
)

it('keeps GitHub attachment staging and upload remote for an overriding project', async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-desktop-gh-image-remote-'))
  const request = desktopRoute(directory, {
    gitExecution: 'local',
    gitExecutionProjects: { [directory]: 'remote' }
  })
  const gitExecutionRepo = 'id:sandbox-project'
  const target = { kind: 'slug', owner: 'acme', repo: 'widgets' }

  expect(
    await request({
      method: 'clipboard.startImageUpload',
      params: { expectedBase64Length: 12, gitExecutionTarget: target, gitExecutionRepo }
    })
  ).toBeNull()
  expect(
    await request({
      method: 'github.uploadAttachment',
      params: {
        uploadId: 'remote-upload',
        target,
        fileName: 'image.png',
        contentType: 'image/png',
        gitExecutionRepo
      }
    })
  ).toBeNull()
})

it('refuses a stale pairing before running a desktop mutation', async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-desktop-git-stale-'))
  const request = desktopRoute(directory, { gitExecution: 'local' })

  expect(await request({ expectedPairingRevision: 1 })).toMatchObject({
    ok: false,
    error: { code: 'runtime_environment_changed' }
  })
})

it('refuses local Git execution until its SSH runtime identity is available', async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-desktop-git-unidentified-'))
  const request = desktopRoute(directory, { gitExecution: 'local' }, 'local', { runtimeId: null })

  expect(await request()).toMatchObject({
    ok: false,
    error: { code: 'runtime_environment_changed' }
  })
})

it('returns the SSH identity learned before desktop dispatch', async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-desktop-git-learned-'))
  await mkdir(join(directory, '.git'))
  const request = desktopRoute(directory, { gitExecution: 'local' }, 'local', {
    runtimeId: null,
    currentRuntimeId: 'learned-sandbox-runtime'
  })

  expect(await request({ method: 'git.mutationInFlight' })).toMatchObject({
    ok: true,
    result: { inFlight: false },
    _meta: { runtimeId: 'learned-sandbox-runtime' }
  })
})

it('refuses a repository owned by a nested SSH host', async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-desktop-git-nested-'))
  const request = desktopRoute(directory, { gitExecution: 'local' }, 'ssh:nested')

  await expect(
    request({
      method: 'github.updateIssue',
      params: { repo: 'id:sandbox-project', number: 42, updates: { title: 'Nested project' } }
    })
  ).rejects.toThrow('Nested SSH repositories cannot use desktop Git execution')
})

installRealWorkerThreadChildProcesses()
