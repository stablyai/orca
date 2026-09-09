# FE-FLEET-SOL-001: `FleetServerSchema` gains `vaultSshRole`

**CR:** [CR-FLEET-001](../../../../../../docs/crs/v4/fleet-provisioning/CR-FLEET-001-bulk-provision-from-yaml.md)
**Service:** `frontend` (`frontend/src/shared/fleet-config-parser.ts`)
**Backend-go counterpart:** [BE-FLEET-SOL-001](../../../../../backend-go/crs/v4/fleet-provisioning/solutions/BE-FLEET-SOL-001-bulk-provision-from-yaml.md) — `backend-go`'s `BulkProvisionFleet` usecase/RPC, already ✅ DONE and independent of this piece (`infra-fleet-service` never parses YAML itself; it only ever receives an already-parsed/validated `FleetSpec`).

---

## Bối cảnh

`backend-go`'s Vault-only SSH invariant (`domain.NewSshTarget`, see
`ssh_target.go`'s `ErrEmptyVaultSSHRole`) means any client building a
`BulkProvisionFleetRequest` must supply `vaultSshRole`, not the old
`identityFile` field (that field only ever applied to the `desktop/`
legacy path). `frontend/src/shared/fleet-config-parser.ts`'s
`FleetServerSchema` doesn't have this field yet — so no fleet YAML file
can currently produce a request `backend-go`'s validation will accept.

This is the one piece of CR-FLEET-001's "Changes Required" outside
`backend-go/` — moved here from `specs/backend-go/crs/v4/fleet-provisioning/`
where it was originally drafted as `TASK-BE-FLEET-005` (a prior
backend-go-only execution session skipped it there, correctly, since it
had no permission to touch `frontend/`; see that file's history note for
the full reasoning).

## Design — same as originally drafted

Add 1 optional field to the existing Zod schema, keep `identityFile` for
backward compatibility with the `desktop/` legacy path, mark it
`@deprecated` for the `backend-go` path only. No validate-at-parse-time
logic — "required if targeting backend-go" is a UI-layer concern
(`FleetProvisionWizard.tsx`'s confirm step), not a schema-shape concern.

See [FE-TASK-FLEET-001](../tasks/FE-TASK-FLEET-001-yaml-schema-vault-ssh-role.md)
for the exact field, position, and test plan.

## Changes Required

1. `frontend/src/shared/fleet-config-parser.ts` — `FleetServerSchema` gains `vaultSshRole: z.string().optional()`.

## Liên quan

- [CR-FLEET-001](../../../../../../docs/crs/v4/fleet-provisioning/CR-FLEET-001-bulk-provision-from-yaml.md)
- [BE-FLEET-SOL-001](../../../../../backend-go/crs/v4/fleet-provisioning/solutions/BE-FLEET-SOL-001-bulk-provision-from-yaml.md)
