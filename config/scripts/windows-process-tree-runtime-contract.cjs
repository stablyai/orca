'use strict'

const PROCESS_TABLE_CONTRACT_VERSION = 1

async function assertWindowsProcessTreeRuntime(addon, options = {}) {
  if (addon?.processTableContractVersion !== PROCESS_TABLE_CONTRACT_VERSION) {
    throw new Error(
      `process-table contract ${String(addon?.processTableContractVersion)} is stale; expected ${PROCESS_TABLE_CONTRACT_VERSION}`
    )
  }
  if (typeof addon.getProcessList !== 'function') {
    throw new Error('process-table addon does not export getProcessList')
  }
  const pid = options.pid ?? process.pid
  const timeoutMs = options.timeoutMs ?? 3_000
  const rows = await new Promise((resolve, reject) => {
    let settled = false
    const deadline = setTimeout(() => {
      settled = true
      reject(new Error('process-table callback timed out'))
    }, timeoutMs)
    addon.getProcessList((result) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(deadline)
      resolve(result)
    }, 7)
  })
  const self = Array.isArray(rows) ? rows.find((row) => row.pid === pid) : undefined
  if (
    !self ||
    !Number.isFinite(self.memory) ||
    !Number.isFinite(self.privateMemory) ||
    !/^\d+$/.test(self.cpuTimeTicks ?? '') ||
    !/^\d+$/.test(self.startTimeId ?? '') ||
    typeof self.commandLine !== 'string'
  ) {
    throw new Error('process-table self row is missing identity or resource fields')
  }
}

module.exports = { PROCESS_TABLE_CONTRACT_VERSION, assertWindowsProcessTreeRuntime }
