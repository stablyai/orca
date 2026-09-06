import process from 'node:process'

export function waitForEmulatorLauncherShutdown(
  { metro, removeRuntimeRestart, runtimeState },
  signalTarget = process
) {
  return new Promise((resolve, reject) => {
    let stopping = false
    let finishing = false
    let stopTimeout = null
    const finish = async () => {
      if (finishing) {
        return
      }
      finishing = true
      if (stopTimeout) {
        clearTimeout(stopTimeout)
      }
      metro.process.off('exit', finish)
      signalTarget.off('SIGINT', stopMetro)
      signalTarget.off('SIGTERM', stopMetro)
      removeRuntimeRestart()
      metro.closeOutput?.()
      try {
        await runtimeState.current?.stop({ shutdownDaemon: true })
        resolve()
      } catch (error) {
        reject(error)
      }
    }
    const stopMetro = () => {
      if (stopping) {
        void finish()
        return
      }
      stopping = true
      metro.process.kill('SIGINT')
      stopTimeout = setTimeout(finish, 2000)
      stopTimeout.unref?.()
    }
    metro.process.once('exit', finish)
    if (metro.isExited()) {
      void finish()
      return
    }
    signalTarget.once('SIGINT', stopMetro)
    signalTarget.once('SIGTERM', stopMetro)
  })
}
