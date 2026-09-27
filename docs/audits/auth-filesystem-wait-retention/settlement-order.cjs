const turn = () => new Promise((resolveTurn) => setImmediate(resolveTurn))

module.exports = async function settlementOrder(create) {
  const cases = []
  for (const startedBefore of [true, false]) {
    for (const rejectRaw of [false, true]) {
      for (let ticks = 0; ticks < 6; ticks++) {
        let settle
        const operation = create(
          'synthetic-auth-order',
          () =>
            new Promise((resolveRaw, failRaw) => {
              settle = () => (rejectRaw ? failRaw('raw failure') : resolveRaw('raw success'))
            })
        )
        await turn()
        const controller = new AbortController()
        const start = () =>
          operation.wait(controller.signal).then(
            (value) => ({ status: 'fulfilled', value }),
            (reason) => ({ status: 'rejected', reason })
          )
        let waiting = startedBefore ? start() : null
        settle()
        for (let index = 0; index < ticks; index++) {
          await Promise.resolve()
        }
        if (!startedBefore) {
          waiting = start()
        }
        controller.abort('caller aborted')
        cases.push({ startedBefore, rejectRaw, ticks, outcome: await waiting })
      }
    }
  }
  return cases
}
