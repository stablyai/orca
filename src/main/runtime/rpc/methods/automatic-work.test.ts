import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { denyRpcMethodForCaller } from '../rpc-caller-scope'
import { eraseRpcMethods } from '../core'
import { AUTOMATIC_WORK_METHODS } from './automatic-work'
import type { RpcContext } from '../core'
import type { RuntimePtyController } from '../../runtime-pty-controller-contract'

function context(runtime: OrcaRuntimeService): RpcContext {
  return { runtime }
}

function method(name: string) {
  const found = eraseRpcMethods(AUTOMATIC_WORK_METHODS).find((candidate) => candidate.name === name)
  if (!found) {
    throw new Error(`Missing method ${name}`)
  }
  return found
}

function runtimeWithController(
  controller: Pick<RuntimePtyController, 'getAutomaticWorkStatus' | 'resumeAutomaticWork'>
): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService(null)
  runtime.setPtyController({
    spawn: vi.fn(),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    ...controller
  })
  return runtime
}

describe('runtime.automaticWork RPC methods', () => {
  it('resumes through the local terminal owner and reports what it cleared', async () => {
    const cleared = { kind: 'paused' as const, reason: 'unclean_host_death' as const, since: 5 }
    const resumeAutomaticWork = vi.fn(async () => ({
      admission: 'enforce' as const,
      mode: { kind: 'normal' as const },
      cleared
    }))
    const runtime = runtimeWithController({ resumeAutomaticWork })

    await expect(
      method('runtime.automaticWork.resume').handler(undefined, context(runtime))
    ).resolves.toEqual({
      automaticWork: { admission: 'enforce', mode: { kind: 'normal' }, cleared }
    })
    expect(resumeAutomaticWork).toHaveBeenCalledOnce()
  })

  it('answers null when the local owner has no gate', async () => {
    const runtime = runtimeWithController({})
    await expect(
      method('runtime.automaticWork.status').handler(undefined, context(runtime))
    ).resolves.toEqual({ automaticWork: null })
    await expect(
      method('runtime.automaticWork.resume').handler(undefined, context(runtime))
    ).resolves.toEqual({ automaticWork: null })
  })

  it('says when the running terminal host predates resume instead of claiming no gate', async () => {
    const runtime = runtimeWithController({
      resumeAutomaticWork: async () => 'terminal-host-predates-resume' as const
    })
    await expect(
      method('runtime.automaticWork.resume').handler(undefined, context(runtime))
    ).resolves.toEqual({ automaticWork: null, terminalHostPredatesResume: true })
  })

  it('lets a paired desktop resume but never a phone', () => {
    const resume = method('runtime.automaticWork.resume')
    expect(resume.permission).toBe('host-admin')
    expect(
      denyRpcMethodForCaller({ kind: 'runtime-paired', grants: [] }, resume.name, resume.permission)
    ).toBeNull()
    expect(
      denyRpcMethodForCaller({ kind: 'mobile' }, resume.name, resume.permission)
    ).not.toBeNull()
  })
})
