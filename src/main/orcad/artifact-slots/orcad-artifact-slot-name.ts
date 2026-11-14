// Grammar of the version slot directories under orcad-artifacts/<target>/.
const SLOT_NAME = /^([0-9A-Za-z.-]+\+[a-f0-9]{12})(?:\.repair-\d+)?$/u

/** A repair attempt sits beside the original slot so readers of the old bytes are undisturbed. */
export function orcadArtifactSlotName(fullVersion: string, repairAttempt: number): string {
  return repairAttempt ? `${fullVersion}.repair-${repairAttempt}` : fullVersion
}

/** Null for every sibling that is not a slot: `runtimes/`, staging dirs, foreign entries. */
export function orcadArtifactSlotVersion(name: string): string | null {
  return SLOT_NAME.exec(name)?.[1] ?? null
}
