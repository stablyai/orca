// Mobile never uses `z.locales.*` beyond English; omit the other 57 Zod locale modules from Metro bundles.
const en = require('zod/v4/locales/en.cjs')
exports.en = en.default || en
