import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { encodeStructuredAgentSessionOptionValue } from '../../../shared/structured-agent-session-option-codec'
import type { StructuredAgentSessionPermissionMode } from '../../../shared/structured-agent-session-permission-mode'

export type NativeSessionOptionRestoration = {
  options: Readonly<Record<string, string>>
  permissionModeRestoreValue?: StructuredAgentSessionPermissionMode
}

export async function readNativeSessionOptionRestoration(input: {
  adapter: Pick<StructuredAgentSessionAdapter, 'readOptions' | 'readOptionRestoreFailures'>
  sessionId: string
  fence: number
  priorOptions?: Readonly<Record<string, string>>
  permissionModeAdoption?: 'required' | 'if-confirmed'
}): Promise<NativeSessionOptionRestoration | undefined> {
  const reported = await input.adapter.readOptions?.({
    sessionId: input.sessionId,
    fence: input.fence
  })
  if (!reported) {
    if (input.permissionModeAdoption === 'required') {
      throw new Error('The resumed provider did not report its current permission mode.')
    }
    return undefined
  }
  return {
    options: restoredNativeSessionOptions(input, reported),
    ...(reported.permissionModeRestoreValue
      ? { permissionModeRestoreValue: reported.permissionModeRestoreValue }
      : {})
  }
}

export async function readNativeSessionOptions(input: {
  adapter: Pick<StructuredAgentSessionAdapter, 'readOptions' | 'readOptionRestoreFailures'>
  sessionId: string
  fence: number
  priorOptions?: Readonly<Record<string, string>>
}): Promise<Readonly<Record<string, string>> | undefined> {
  return (await readNativeSessionOptionRestoration(input))?.options
}

function restoredNativeSessionOptions(
  input: {
    adapter: Pick<StructuredAgentSessionAdapter, 'readOptionRestoreFailures'>
    sessionId: string
    priorOptions?: Readonly<Record<string, string>>
    permissionModeAdoption?: 'required' | 'if-confirmed'
  },
  reported: NonNullable<
    Awaited<ReturnType<NonNullable<StructuredAgentSessionAdapter['readOptions']>>>
  >
): Readonly<Record<string, string>> {
  const { sessionId, priorOptions } = input
  const skipped = new Set(input.adapter.readOptionRestoreFailures?.(sessionId) ?? [])
  const restored = priorOptions ? { ...priorOptions } : {}
  delete restored.model
  delete restored.effort
  delete restored.fastMode
  for (const key of skipped) {
    delete restored[key]
  }
  const restoredPermissionMode = restored.permissionMode
  if (
    restoredPermissionMode !== undefined &&
    restoredPermissionMode === reported.permissionModeRestoreValue &&
    restoredPermissionMode === reported.current.permissionMode &&
    reported.current.confirmed?.includes('permissionMode') === true
  ) {
    delete restored.permissionMode
  }
  if (input.permissionModeAdoption) {
    const permissionMode = reported.current.permissionMode
    const confirmed = reported.current.confirmed?.includes('permissionMode') === true
    if ((!permissionMode || !confirmed) && input.permissionModeAdoption === 'required') {
      throw new Error('The resumed provider did not report its current permission mode.')
    }
    if (permissionMode && confirmed) {
      delete restored.permissionMode
      if (permissionMode === 'plan') {
        restored.permissionMode = 'plan'
      }
    }
  }
  const fastMode =
    reported.current.fastMode === undefined
      ? undefined
      : encodeStructuredAgentSessionOptionValue('fastMode', reported.current.fastMode)
  return {
    ...restored,
    model: reported.current.model,
    ...(reported.current.effort ? { effort: reported.current.effort } : {}),
    ...(fastMode !== undefined && fastMode !== null ? { fastMode } : {})
  }
}
