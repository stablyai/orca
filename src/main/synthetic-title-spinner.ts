export type SyntheticTitleSpinnerEntry<TProfile> = {
  frame: number
  profile: TProfile
}

export type SyntheticTitleSpinnerTick<TProfile> = {
  paneKey: string
  ptyId: string
  frame: number
  profile: TProfile
}

export function advanceSyntheticTitleSpinnerEntries<TProfile>(args: {
  entries: Map<string, SyntheticTitleSpinnerEntry<TProfile>>
  frameCount: number
  getPtyIdForPaneKey: (paneKey: string) => string | null | undefined
}): SyntheticTitleSpinnerTick<TProfile>[] {
  if (args.frameCount <= 0) {
    return []
  }

  const ticks: SyntheticTitleSpinnerTick<TProfile>[] = []
  for (const [paneKey, entry] of args.entries) {
    const ptyId = args.getPtyIdForPaneKey(paneKey)
    if (!ptyId) {
      args.entries.delete(paneKey)
      continue
    }
    entry.frame = (entry.frame + 1) % args.frameCount
    ticks.push({ paneKey, ptyId, frame: entry.frame, profile: entry.profile })
  }
  return ticks
}
