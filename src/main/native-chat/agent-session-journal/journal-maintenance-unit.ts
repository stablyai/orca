export type JournalMaintenanceUnit = { kind: 'retired'; after: number }
export type JournalMaintenanceResult = {
  more: boolean
  elapsed: number
  position?: number
}
