import { runProcess } from '@orca/process-host'
import type { ProcessSpec } from '@orca/process-host/process-spec'

type HermesAcpPreflightInput = Pick<ProcessSpec, 'program' | 'cwd' | 'env'> & {
  prefixArgs: readonly string[]
}

export async function assertAcpDependency(
  agent: string,
  input: HermesAcpPreflightInput
): Promise<void> {
  if (agent === 'hermes') {
    await assertHermesAcpDependency(input)
  }
}

export async function assertHermesAcpDependency(input: HermesAcpPreflightInput): Promise<void> {
  let output: string
  try {
    const result = await runProcess({
      program: input.program,
      args: [...input.prefixArgs, 'acp', '--check'],
      cwd: input.cwd,
      env: input.env,
      terminationBarrier: true,
      timeoutMs: 5_000,
      maxOutputBytes: 8_192,
      killOnOutputLimit: true
    })
    if (result.timedOut || result.outputTruncated || result.code === 0) {
      return
    }
    output = `${result.stdout}\n${result.stderr}`
  } catch {
    return
  }
  if (/No module named ["']acp(?:\.[^"']*)?["']/.test(output)) {
    throw new Error(
      'Hermes ACP requires the agent-client-protocol dependency. Run `hermes acp --check` for the install command.'
    )
  }
}
