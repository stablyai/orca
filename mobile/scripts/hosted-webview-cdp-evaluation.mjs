const CDP_MESSAGE_MAX_BYTES = 2 * 1024 * 1024

export function evaluateHostedWebViewCdp(endpoint, expression, WebSocketCtor) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocketCtor(endpoint, {
      maxPayload: CDP_MESSAGE_MAX_BYTES
    })
    const timer = setTimeout(() => finish(new Error('WebKit CDP evaluation timed out')), 3_000)
    let settled = false

    const finish = (error, value) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      let completed = false
      const complete = () => {
        if (completed) {
          return
        }
        completed = true
        if (error) {
          reject(error)
        } else {
          resolve(value)
        }
      }
      const closeTimer = setTimeout(complete, 250)
      socket.once('close', () => {
        clearTimeout(closeTimer)
        complete()
      })
      socket.close()
    }

    socket.once('open', () => {
      socket.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true }
        })
      )
    })
    socket.on('message', (data) => {
      try {
        if (data.length > CDP_MESSAGE_MAX_BYTES) {
          finish(new Error('WebKit CDP response exceeded its size limit'))
          return
        }
        const message = JSON.parse(String(data))
        if (message.id !== 1) {
          return
        }
        if (message.error || message.result?.exceptionDetails) {
          const exception = message.result?.exceptionDetails
          finish(
            new Error(
              message.error?.message ??
                exception?.exception?.description ??
                exception?.text ??
                'WebKit CDP evaluation failed'
            )
          )
          return
        }
        const value = message.result?.result?.value
        if (typeof value !== 'string') {
          finish(new Error('WebKit CDP evaluation returned an invalid value'))
          return
        }
        finish(null, value)
      } catch (error) {
        finish(error)
      }
    })
    socket.once('error', (error) => finish(error))
    socket.once('close', () => finish(new Error('WebKit CDP connection closed')))
  })
}
