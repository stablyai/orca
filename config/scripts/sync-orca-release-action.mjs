import { join } from 'node:path'
import { syncOrcaRelease } from './sync-orca-release.mjs'

export async function runOrcaReleaseAction({ github, context, core, exec }) {
  const base = context.payload.repository.default_branch
  if (context.ref !== `refs/heads/${base}`) {
    throw new Error('Orca sync must run from the default branch.')
  }
  const git = (args) =>
    exec.getExecOutput(
      'git',
      [
        '-c',
        `core.hooksPath=${join(process.env.RUNNER_TEMP, 'orca-sync-disabled-hooks')}`,
        '-c',
        'commit.gpgSign=false',
        ...args
      ],
      { ignoreReturnCode: true, silent: true }
    )
  const result = await syncOrcaRelease({
    github,
    git,
    repo: context.repo,
    base,
    manual: context.eventName === 'workflow_dispatch',
    overrideTag: process.env.OVERRIDE_TAG
  })
  core.info(result)
  await core.summary.addRaw(result).write()
}
