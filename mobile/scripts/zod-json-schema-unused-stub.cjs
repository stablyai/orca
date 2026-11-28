// Mobile never calls `z.toJSONSchema` or `z.fromJSONSchema`; omit Zod's JSON Schema compilers from Metro bundles.
function unsupported() {
  throw new Error('Zod JSON Schema conversion is not bundled in mobile')
}
exports.toJSONSchema = unsupported
exports.fromJSONSchema = unsupported
exports.JSONSchemaGenerator = unsupported
