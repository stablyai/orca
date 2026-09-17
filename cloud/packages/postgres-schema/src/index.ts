export {
  applyPostgresSchema,
  type SchemaApplySummary,
  type SchemaStartupOptions
} from './apply-postgres-schema.js'
export {
  catalogObjectPresence,
  type SchemaCatalogPresence,
  type SchemaCatalogQuery,
  type SchemaCatalogRow
} from './catalog-object-precheck.js'
export {
  requireSchemaLockTarget,
  schemaLockTarget,
  sqlWithoutComments,
  takesRelationLock,
  type SchemaLockTarget
} from './schema-lock-target.js'
