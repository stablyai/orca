/** The first line of an error, for one short row detail. */
export function orcaUninstallErrorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0]
}
