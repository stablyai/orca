// An adhoc run builds one commit: every job checks out what resolve-ref pinned at dispatch, so a
// push mid-run can never mix slot lanes from one commit with a template merge from the next.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { configureRealGitTestRepo } from '../../src/main/git/real-git-test-repo.ts'
import { runProcess } from '@orca/process-host'

const workflow = parse(readFileSync('.github/workflows/adhoc-mac-build.yml', 'utf8'))
const PINNED = '${{ needs.resolve-ref.outputs.sha }}'
const resolveStep = workflow.jobs['resolve-ref'].steps.find((step) => step.id === 'resolve')
const directory = mkdtempSync(join(tmpdir(), 'adhoc-pinned-commit-'))
const repository = join(directory, 'remote.git')
const identity = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Ref test',
  GIT_AUTHOR_EMAIL: 'ref-test@example.com',
  GIT_COMMITTER_NAME: 'Ref test',
  GIT_COMMITTER_EMAIL: 'ref-test@example.com'
}
let branchTip, tagged

async function git(args) {
  const result = await runProcess({ program: 'git', args, env: identity })
  expect(result.code, result.stderr).toBe(0)
  return result.stdout.trim()
}

async function resolve(ref) {
  const scratch = mkdtempSync(join(directory, 'attempt-'))
  const script = join(scratch, 'resolve.sh')
  writeFileSync(script, resolveStep.run)
  const output = join(scratch, 'output')
  writeFileSync(output, '')
  const result = await runProcess({
    program: 'bash',
    args: [script],
    env: {
      ...identity,
      REPO_URL: pathToFileURL(repository).href,
      GITHUB_OUTPUT: output,
      REQUESTED_REF: ref
    }
  })
  return { code: result.code, output: readFileSync(output, 'utf8').trim() }
}

beforeAll(async () => {
  await git(['init', '--bare', repository])
  configureRealGitTestRepo(repository)
  const tree = await git(['-C', repository, 'mktree'])
  tagged = await git(['-C', repository, 'commit-tree', tree, '-m', 'tagged'])
  branchTip = await git(['-C', repository, 'commit-tree', tree, '-p', tagged, '-m', 'tip'])
  await git(['-C', repository, 'update-ref', 'refs/heads/feature/x', branchTip])
  await git(['-C', repository, 'tag', '-a', 'v1', tagged, '-m', 'annotated'])
})

afterAll(() => rmSync(directory, { recursive: true, force: true }))

describe('adhoc build pins one commit for the whole run', () => {
  it('checks out the pinned commit in every job that builds from the repo', () => {
    const { jobs } = workflow
    expect(jobs['relay-windows-process-tree'].with.ref).toBe(PINNED)
    expect(jobs['orcad-template'].with.ref).toBe(PINNED)
    const support = jobs['orcad-template-support'].steps.find((step) =>
      step.uses?.startsWith('actions/checkout@')
    )
    expect(support.with.ref).toBe(PINNED)
    const vet = jobs['build-adhoc-mac'].steps.find((step) => step.id === 'vetted')
    expect(vet.env.REQUESTED_REF).toBe(PINNED)
    for (const name of [
      'relay-windows-process-tree',
      'orcad-template-support',
      'orcad-template',
      'build-adhoc-mac'
    ]) {
      expect([jobs[name].needs].flat(), name).toContain('resolve-ref')
    }
  })

  it('resolves a branch, an annotated tag to its commit, and passes a full SHA through', async () => {
    expect(await resolve('feature/x')).toEqual({ code: 0, output: `sha=${branchTip}` })
    expect(await resolve('v1')).toEqual({ code: 0, output: `sha=${tagged}` })
    expect(await resolve(tagged)).toEqual({ code: 0, output: `sha=${tagged}` })
  })

  it('refuses PR refs and names it cannot resolve', async () => {
    for (const ref of ['refs/pull/1/head', 'pull/1/head', 'missing', tagged.slice(0, 12)]) {
      expect(await resolve(ref), ref).toEqual({ code: 1, output: '' })
    }
  })
})
