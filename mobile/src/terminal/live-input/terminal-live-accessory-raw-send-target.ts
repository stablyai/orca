type TerminalLiveAccessoryRawSendTargetInput<TTabType extends string> = {
  readonly targetHandle: string
  readonly activeHandle: string | null
  readonly activeSessionTabType: TTabType | null
}

export function getTerminalLiveAccessoryRawSendTarget<TTabType extends string>({
  targetHandle,
  activeHandle,
  activeSessionTabType
}: TerminalLiveAccessoryRawSendTargetInput<TTabType>): string | null {
  if (targetHandle !== activeHandle || activeSessionTabType !== 'terminal') {
    return null
  }

  return targetHandle
}
