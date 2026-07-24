import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildPosixRemoteNodeCandidateProbe,
  REMOTE_NODE_CANDIDATE_LIMIT_SENTINEL,
  REMOTE_NODE_CANDIDATE_MAX_COUNT,
  REMOTE_NODE_CANDIDATE_MAX_UTF8_BYTES,
  REMOTE_NODE_PROFILE_MAX_BYTES
} from './ssh-remote-node-candidate-probe'

describe('POSIX remote Node candidate probe', () => {
  it('uses bounded profile reads, batched directory iteration, and bounded output', () => {
    const script = buildPosixRemoteNodeCandidateProbe()

    expect(script).toContain('dd if="$nvm_file" bs=1024 count=65')
    expect(script).toContain(`-le ${REMOTE_NODE_PROFILE_MAX_BYTES}`)
    expect(script).toContain(`find "$candidate_root" -mindepth 1 -maxdepth 1 ! -name '.*'`)
    expect(script).toContain('-exec sh -c')
    expect(script).toContain('{} +')
    expect(script).toContain('| sort')
    expect(script).toContain(`candidate_count>=${REMOTE_NODE_CANDIDATE_MAX_COUNT}`)
    expect(script).toContain(`output_bytes+line_bytes>${REMOTE_NODE_CANDIDATE_MAX_UTF8_BYTES}`)
    expect(script).toContain(REMOTE_NODE_CANDIDATE_LIMIT_SENTINEL)
    expect(script).not.toContain('/*/')
  })

  it.runIf(process.platform !== 'win32')(
    'accepts an exact-limit profile and ignores its first byte of overflow',
    () => {
      const home = mkdtempSync(join(tmpdir(), 'orca-node-profile-limit-'))
      try {
        const nodePath = join(home, 'tilde-nvm', 'versions', 'node', 'v20', 'bin', 'node')
        mkdirSync(join(home, 'tilde-nvm', 'versions', 'node', 'v20', 'bin'), {
          recursive: true
        })
        writeFileSync(nodePath, '#!/bin/sh\nexit 0\n')
        chmodSync(nodePath, 0o755)
        const assignment = 'export NVM_DIR=~/tilde-nvm\n'
        const exactProfile =
          assignment + '#'.repeat(REMOTE_NODE_PROFILE_MAX_BYTES - assignment.length)
        writeFileSync(join(home, '.profile'), exactProfile)
        const script = buildPosixRemoteNodeCandidateProbe()
        const environment = { ...process.env, HOME: home, NVM_DIR: '' }

        const exactOutput = execFileSync('/bin/sh', ['-c', script], {
          encoding: 'utf8',
          env: environment
        })
        expect(exactOutput.split('\n')).toContain(nodePath)

        writeFileSync(join(home, '.profile'), `${exactProfile}x`)
        const oversizedOutput = execFileSync('/bin/sh', ['-c', script], {
          encoding: 'utf8',
          env: environment
        })
        expect(oversizedOutput.split('\n')).not.toContain(nodePath)
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    }
  )

  it.runIf(process.platform !== 'win32')(
    'preserves lexical version ordering within each bounded manager directory',
    () => {
      const home = mkdtempSync(join(tmpdir(), 'orca-node-version-order-'))
      try {
        const nvmDir = join(home, 'nvm')
        const newer = join(nvmDir, 'versions', 'node', 'v22', 'bin', 'node')
        const older = join(nvmDir, 'versions', 'node', 'v18', 'bin', 'node')
        for (const nodePath of [newer, older]) {
          mkdirSync(join(nodePath, '..'), { recursive: true })
          writeFileSync(nodePath, '#!/bin/sh\nexit 0\n')
          chmodSync(nodePath, 0o755)
        }

        const output = execFileSync('/bin/sh', ['-c', buildPosixRemoteNodeCandidateProbe()], {
          encoding: 'utf8',
          env: { ...process.env, HOME: home, NVM_DIR: nvmDir }
        }).split('\n')

        expect(output.indexOf(older)).toBeLessThan(output.indexOf(newer))
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    }
  )
})
