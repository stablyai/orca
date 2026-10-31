const { workerData } = require('node:worker_threads')
const counters = new Int32Array(workerData.gate)
exports.createOnlineRecognizer = () => ({})
exports.createOnlineStream = () => ({})
exports.acceptWaveformOnline = (_stream, { samples }) => {
  if (Atomics.load(counters, 0) === 0) {
    Atomics.store(counters, 0, 1)
    Atomics.wait(counters, 1, 0, 10000)
  }
  const index = Atomics.add(counters, 2, 1)
  Atomics.add(counters, 3, samples.length)
  if (samples[0] !== index % 10 || samples.at(-1) !== index % 10) {
    throw new Error('Audio order/content changed')
  }
  if (workerData.failOnce && index === 0) {
    throw new Error('Controlled recognizer failure')
  }
}
exports.isOnlineStreamReady = () => false
exports.getOnlineStreamResultAsJson = () => '{}'
exports.isEndpoint = () => false
exports.inputFinished = () => {}
