import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcessSync } from '@orca/process-host'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const workflow = parse(readFileSync('.github/workflows/release-cut.yml', 'utf8'))
const step = workflow.jobs.cut.steps.find((candidate) => candidate.name === 'Push tag')

function pushRelease(mode, pushMain = 'true') {
  const directory = mkdtempSync(join(tmpdir(), 'orca-release-push-'))
  try {
    writeFileSync(
      join(directory, 'step.sh'),
      `git() {
        printf '%s\\n' "$*" >> calls.log
        if [[ "$*" == 'push origin HEAD:refs/heads/main' ]]; then
          case "$PUSH_TEST_MODE" in
            protected)
              echo 'remote: error: GH013: Repository rule violations found for refs/heads/main.' >&2
              echo 'remote: - Changes must be made through a pull request.' >&2
              return 1 ;;
            rejected)
              echo 'remote: error: GH013: Required status check is missing.' >&2
              return 1 ;;
            disconnected)
              echo 'fatal: unable to access remote' >&2
              return 128 ;;
          esac
        elif [[ "$PUSH_TEST_MODE" == 'tag-rejected' ]]; then
          echo 'remote: tag update rejected' >&2
          return 1
        fi
      }
      ${step.run}`
    )
    const result = runProcessSync({
      program: 'bash',
      args: ['step.sh'],
      cwd: directory,
      env: { PUSH_MAIN: pushMain, TAG: 'v1.4.229', RUNNER_TEMP: '.', PUSH_TEST_MODE: mode }
    })
    return {
      ...result,
      calls: readFileSync(join(directory, 'calls.log'), 'utf8').trim().split('\n')
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('release tag push with protected main', () => {
  it('still publishes the tag when main requires a pull request', () => {
    const result = pushRelease('protected')
    expect(result.code, result.stderr).toBe(0)
    expect(result.calls).toEqual(['push origin HEAD:refs/heads/main', 'push origin v1.4.229'])
    expect(result.stdout).toContain('leaving its version unchanged')
  })

  it('keeps the version fast-forward when direct updates are permitted', () => {
    const result = pushRelease('allowed')
    expect(result.code, result.stderr).toBe(0)
    expect(result.calls).toEqual(['push origin HEAD:refs/heads/main', 'push origin v1.4.229'])
  })

  it.each(['rejected', 'disconnected'])('stops without a tag for %s main push errors', (mode) => {
    const result = pushRelease(mode)
    expect(result.code).not.toBe(0)
    expect(result.calls).toEqual(['push origin HEAD:refs/heads/main'])
  })

  it('only pushes the tag for an off-main source', () => {
    const result = pushRelease('protected', 'false')
    expect(result.code, result.stderr).toBe(0)
    expect(result.calls).toEqual(['push origin v1.4.229'])
  })

  it('still fails when the tag push is rejected', () => {
    expect(pushRelease('tag-rejected', 'false').code).not.toBe(0)
  })
})
