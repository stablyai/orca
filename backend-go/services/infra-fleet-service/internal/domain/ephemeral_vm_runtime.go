package domain

import (
	"errors"
	"time"
)

// EphemeralVmRuntime is the durable, tenant-scoped record of an ephemeral
// VM/container instance provisioned from a repo's orca.yaml
// environmentRecipes entry — SOL-004 Group 1/2a
// (specs/backend-go/bugs/missing-v3/solutions/SOL-004-ephemeralvm-channels.md).
// Written by EphemeralVmRelay (TASK-004), read by ListEphemeralVmRuntimes
// (TASK-002).
type EphemeralVmRuntime struct {
	ID             string
	RepoID         string
	RecipeID       string
	ConnectionType string // "orca-server" | "ssh" | ""
	Status         string // "provisioning" | "active" | "suspended" | "error" | "destroyed"
	EnvironmentID  string
	WorkspaceID    string
	LastError      string
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

// ErrEphemeralVmRuntimeNotFound is returned by EphemeralVmRuntimeStore's
// by-id/by-workspace lookups when no matching, non-destroyed row exists.
var ErrEphemeralVmRuntimeNotFound = errors.New("domain: ephemeral vm runtime not found")
