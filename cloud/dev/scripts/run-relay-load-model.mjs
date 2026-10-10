import { assertSpreadModel, modeledRelayLoad } from './relay-load-model.mjs'

const counts = process.argv.slice(2).length > 0 ? process.argv.slice(2).map(Number) : [4_000, 10_000]
for (const count of counts) {
  const model = modeledRelayLoad(count)
  assertSpreadModel(model)
  console.log(JSON.stringify(model))
}
