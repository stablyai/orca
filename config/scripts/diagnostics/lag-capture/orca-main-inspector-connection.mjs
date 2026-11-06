export async function connectOrcaMainInspector(expectedPid, rendererId = 1) {
  const [target] = await (await fetch('http://127.0.0.1:9229/json/list')).json()
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.onopen = resolve
    socket.onerror = reject
  })
  const pending = new Map()
  let nextId = 0
  socket.onclose = () => {
    for (const [id, callback] of pending) {
      pending.delete(id)
      clearTimeout(callback.timer)
      callback.reject(new Error('Inspector socket closed'))
    }
  }
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data)
    const callback = pending.get(message.id)
    if (!callback) {
      return
    }
    pending.delete(message.id)
    clearTimeout(callback.timer)
    if (message.error) {
      callback.reject(new Error(JSON.stringify(message.error)))
    } else {
      callback.resolve(message.result)
    }
  }
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (socket.readyState !== WebSocket.OPEN) {
        reject(new Error('Inspector socket is not open'))
        return
      }
      const id = ++nextId
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`Timed out: ${method}`))
      }, 15_000)
      pending.set(id, { resolve, reject, timer })
      try {
        socket.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        pending.delete(id)
        clearTimeout(timer)
        reject(error)
      }
    })
  }
  async function evaluateMain(expression) {
    const result = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    })
    if (result.exceptionDetails) {
      throw new Error(result.result.description ?? JSON.stringify(result.exceptionDetails))
    }
    return result.result.value
  }
  try {
    if ((await evaluateMain('process.pid')) !== expectedPid) {
      throw new Error('Inspector belongs to a different main process')
    }
  } catch (error) {
    socket.close()
    throw error
  }
  const contents = `process.getBuiltinModule('module').createRequire(process.execPath)('electron').webContents.fromId(${rendererId})`
  return {
    send,
    evaluateMain,
    contents,
    evaluateRenderer: (expression) =>
      evaluateMain(`${contents}.executeJavaScript(${JSON.stringify(expression)})`),
    cdp: (method, params = {}) =>
      evaluateMain(
        `${contents}.debugger.sendCommand(${JSON.stringify(method)},${JSON.stringify(params)})`
      ),
    close: () => socket.close()
  }
}
