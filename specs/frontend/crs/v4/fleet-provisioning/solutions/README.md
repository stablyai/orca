# frontend Solutions — Fleet Provisioning (F31, v4)

**CR:** [CR-FLEET-001](../../../../../../docs/crs/v4/fleet-provisioning/CR-FLEET-001-bulk-provision-from-yaml.md)

F31's design work lives almost entirely in
[specs/backend-go/crs/v4/fleet-provisioning/](../../../../../backend-go/crs/v4/fleet-provisioning/solutions/README.md)
(3 solutions: `BE-FLEET-SOL-001/002/003`). Exactly **1** piece of CR-FLEET-001's
"Changes Required" touches `frontend/` — the fleet YAML schema — split out
here because `specs/backend-go/`'s task-execution scope only covers
`backend-go/` (a prior backend-go session explicitly could not touch
`frontend/`; see `FE-TASK-FLEET-001`'s origin note).

| Solution | Task(s) | Status |
|---|---|---|
| [FE-FLEET-SOL-001](./FE-FLEET-SOL-001-yaml-schema-vault-ssh-role.md) — `FleetServerSchema` gains `vaultSshRole` | [FE-TASK-FLEET-001](../tasks/FE-TASK-FLEET-001-yaml-schema-vault-ssh-role.md) | 🔲 TODO |
