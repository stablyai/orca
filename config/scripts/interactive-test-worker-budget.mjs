const MAX_UNIT_TEST_WORKERS = 4
const LOCAL_ELECTRON_E2E_WORKERS = 2

export function resolveUnitTestWorkerCount(logicalCpus) {
  const normalizedCpus = Number.isFinite(logicalCpus) ? Math.max(1, Math.floor(logicalCpus)) : 1
  return Math.max(1, Math.min(MAX_UNIT_TEST_WORKERS, Math.floor(normalizedCpus / 2)))
}

export function resolveElectronE2eWorkerCount(isCi, logicalCpus) {
  if (isCi) {
    return 1
  }

  const normalizedCpus = Number.isFinite(logicalCpus) ? Math.max(1, Math.floor(logicalCpus)) : 1
  return Math.max(1, Math.min(LOCAL_ELECTRON_E2E_WORKERS, Math.floor(normalizedCpus / 2)))
}
