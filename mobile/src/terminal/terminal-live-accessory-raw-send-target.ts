type TerminalLiveAccessoryRawSendTargetInput<TTabType extends string> = {
  readonly targetHandle: string
  readonly activeHandle: string | null
  readonly activeSessionTabType: TTabType | null
  readonly liveInputTerminalHandles: ReadonlySet<string>
}

export function getTerminalLiveAccessoryRawSendTarget<TTabType extends string>({
  targetHandle,
  activeHandle,
  activeSessionTabType,
  liveInputTerminalHandles
}: TerminalLiveAccessoryRawSendTargetInput<TTabType>): string | null {
  if (
    targetHandle !== activeHandle ||
    activeSessionTabType !== 'terminal' ||
    !liveInputTerminalHandles.has(targetHandle)
  ) {
    return null
  }

  return targetHandle
}
