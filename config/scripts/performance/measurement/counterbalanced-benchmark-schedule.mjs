export function buildCounterbalancedSchedule(pairCount, firstArm, secondArm) {
  if (!Number.isInteger(pairCount) || pairCount <= 0 || pairCount % 2 !== 0) {
    throw new Error('Counterbalanced schedules require a positive even pair count')
  }
  if (!firstArm || !secondArm || firstArm === secondArm) {
    throw new Error('Counterbalanced schedules require two distinct arms')
  }

  return Array.from({ length: pairCount }, (_, index) =>
    index % 2 === 0 ? [firstArm, secondArm] : [secondArm, firstArm]
  )
}
