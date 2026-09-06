export async function stopHostedChildProcess(child) {
  if (!child || child.exitCode !== null) {
    return
  }
  child.kill('SIGTERM')
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(5_000).then(() => {
      if (child.exitCode === null) {
        child.kill('SIGKILL')
      }
    })
  ])
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
