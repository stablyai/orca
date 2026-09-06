const { resolve } = require('node:path')

// Build-time capability probe; production process-table consumers use the shared facade.
function assertWindowsProcessTreeIdentity(
  processTree,
  { pid = process.pid, timeoutMs = 3000 } = {}
) {
  if (
    processTree.ProcessDataFlag?.CreationTime !== 4 ||
    typeof processTree.getProcessList !== 'function'
  ) {
    return Promise.reject(new Error('windows-process-tree is missing the CreationTime API patch'))
  }
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(
      () => reject(new Error('windows-process-tree identity probe timed out')),
      timeoutMs
    )
    try {
      processTree.getProcessList(
        pid,
        (rows) => {
          clearTimeout(timer)
          const self = Array.isArray(rows) ? rows.find((row) => row.pid === pid) : undefined
          if (!Number.isFinite(self?.creationTimeMs) || self.creationTimeMs <= 0) {
            reject(
              new Error(
                'windows-process-tree did not return a positive creationTimeMs for its own process'
              )
            )
          } else {
            resolvePromise(self.creationTimeMs)
          }
        },
        6
      )
    } catch (error) {
      clearTimeout(timer)
      reject(error)
    }
  })
}

module.exports = { assertWindowsProcessTreeIdentity }

if (require.main === module) {
  Promise.resolve()
    .then(() => {
      const processTree = require(resolve(process.argv[2]))
      return assertWindowsProcessTreeIdentity(
        process.argv.includes('--addon')
          ? {
              ProcessDataFlag: processTree.supportsCreationTime === true ? { CreationTime: 4 } : {},
              getProcessList: (_pid, callback, flags) => processTree.getProcessList(callback, flags)
            }
          : processTree
      )
    })
    .then(
      (creationTimeMs) => {
        console.log(
          `[windows-process-tree] native identity OK: pid=${process.pid} creationTimeMs=${
            creationTimeMs
          }`
        )
        process.exit(0)
      },
      (error) => {
        console.error(error.message)
        process.exit(1)
      }
    )
}
