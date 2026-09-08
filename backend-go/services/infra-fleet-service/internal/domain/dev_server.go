// Package domain holds infra-fleet-service's entities and value objects. Per
// specs/backend-go/architecture/03-clean-architecture-guidelines.md, this
// package has zero imports outside stdlib + other domain/ packages — no
// database, no gRPC, no framework.
package domain

import "errors"

// ConnectionMode is the transport this service uses to reach a DevServer —
// mirrors orca.infrafleet.v1.ConnectionMode and TS's provider registry
// transport axis (direct-websocket / relay-websocket / relay-ssh), see
// specs/backend-go/services/infra-fleet-service.md §4.
type ConnectionMode string

const (
	ConnectionModeRelaySSH        ConnectionMode = "relay-ssh"
	ConnectionModeRelayWebSocket  ConnectionMode = "relay-websocket"
	ConnectionModeDirectWebSocket ConnectionMode = "direct-websocket"
)

// Valid reports whether m is one of the known enum values.
func (m ConnectionMode) Valid() bool {
	switch m {
	case ConnectionModeRelaySSH, ConnectionModeRelayWebSocket, ConnectionModeDirectWebSocket:
		return true
	default:
		return false
	}
}

// DevServerStatus is the admin-approval state a DevServer is in — see
// docs/crs/v2/dev-server/CR-DS-006-dev-server-approval-and-grouping.md.
// NOT enforced anywhere yet (Phase 1: data model only) — a
// StatusPendingApproval dev server works exactly like an approved one today.
type DevServerStatus string

const (
	// DevServerStatusPendingApproval is what NewDevServer sets for every
	// freshly-registered dev server — an admin has not yet reviewed it.
	DevServerStatusPendingApproval DevServerStatus = "pending_approval"
	DevServerStatusApproved        DevServerStatus = "approved"
	DevServerStatusRejected        DevServerStatus = "rejected"
)

// Valid reports whether s is one of the known enum values.
func (s DevServerStatus) Valid() bool {
	switch s {
	case DevServerStatusPendingApproval, DevServerStatusApproved, DevServerStatusRejected:
		return true
	default:
		return false
	}
}

// DevServerHealthStatus is the coarse connectivity/health state of a
// DevServer — a DIFFERENT concept from DevServerStatus (admin approval,
// above) and from the frontend's own client-side "connected/disconnected"
// live relay state. Backed by infra.dev_servers.status, a column added
// directly against production by a separate, concurrent effort (see that
// column's own migration-slot placeholder,
// migrations/0007_dev_server_health_status.up.sql, for the full history) —
// this type/field is this session's first Go-side exposure of it, reusing
// the column exactly as committed rather than adding a new one. See
// docs/backlog/BACKLOG-007-dev-server-bootstrap-status-proto-field.md
// (option 2: reuse the coarse status instead of a dedicated bootstrap-step
// field).
type DevServerHealthStatus string

const (
	// DevServerHealthPending is the column's DB default — set when a dev
	// server is registered and not yet confirmed healthy. bootstrap.ts
	// treats this as "still bootstrapping" (option 2's whole point: no
	// dedicated per-step tracking, just this coarse signal).
	DevServerHealthPending   DevServerHealthStatus = "pending"
	DevServerHealthHealthy   DevServerHealthStatus = "healthy"
	DevServerHealthDegraded  DevServerHealthStatus = "degraded"
	DevServerHealthUnhealthy DevServerHealthStatus = "unhealthy"
)

// Valid reports whether s is one of the known enum values — mirrors the
// live table's own dev_servers_status_check constraint.
func (s DevServerHealthStatus) Valid() bool {
	switch s {
	case DevServerHealthPending, DevServerHealthHealthy, DevServerHealthDegraded, DevServerHealthUnhealthy:
		return true
	default:
		return false
	}
}

// AgentKind distinguishes a Dev Server Agent registration from a Mobile
// Emulator Agent registration — both share this same registry via
// RegisterDevServer, see docs/crs/v2/dev-server/
// CR-DS-009-mobile-emulator-agent-separation.md §3.1.
type AgentKind string

const (
	AgentKindDevServer      AgentKind = "dev_server"
	AgentKindMobileEmulator AgentKind = "mobile_emulator"
)

// Valid reports whether k is one of the known enum values.
func (k AgentKind) Valid() bool {
	switch k {
	case AgentKindDevServer, AgentKindMobileEmulator:
		return true
	default:
		return false
	}
}

var (
	// ErrEmptyDevServerTenant is returned when TenantID is empty — a dev
	// server with no owning tenant is never a valid domain state.
	ErrEmptyDevServerTenant = errors.New("domain: tenant_id is required")
	// ErrEmptyHost guards against registering a dev server nobody can reach.
	ErrEmptyHost = errors.New("domain: host is required")
	// ErrInvalidConnectionMode is returned when mode isn't one of the known
	// transport modes.
	ErrInvalidConnectionMode = errors.New("domain: invalid connection mode")
	// ErrMissingSSHTargetForRelaySSH is returned when mode is
	// ConnectionModeRelaySSH but SSHTargetID is empty — relay-ssh's
	// cert-based SSH auth (sshconn.Connector) has no target to dial without
	// it, see specs/backend-go/services/infra-fleet-service.md §9.
	ErrMissingSSHTargetForRelaySSH = errors.New("domain: ssh_target_id is required when mode is relay-ssh")
)

// DevServer is a registered dev host: which tenant owns it, how to reach it
// (host), and which transport mode this service uses to talk to it.
// SSHTargetID links to the SshTarget sshconn.Connector dials for cert-based
// SSH auth — required for relay-ssh mode, empty for the other two modes. See
// specs/backend-go/services/infra-fleet-service.md §4 — this scaffold's
// DevServer is the proto-sized subset of the design doc's fuller entity
// (display name, bootstrap status, agent version are not modeled here; see
// this service's README "Known gaps").
type DevServer struct {
	ID          string
	TenantID    string
	Host        string
	Mode        ConnectionMode
	SSHTargetID string
	// Status and GroupID are CR-DS-006 Phase 1 additions — see that CR and
	// this file's DevServerStatus doc comment. Neither is enforced by any
	// usecase yet; GroupID empty means "ungrouped", a valid state.
	Status  DevServerStatus
	GroupID string
	// HealthStatus — see DevServerHealthStatus's doc comment. Defaults to
	// DevServerHealthPending in the database; NewDevServer below does not
	// set it explicitly (zero value would be "", not a valid enum member)
	// since every INSERT relies on the column's own DB DEFAULT instead —
	// see Repository.RegisterDevServer.
	HealthStatus DevServerHealthStatus
	// Kind is CR-DS-009's Dev Server Agent vs Mobile Emulator Agent
	// distinction — see AgentKind's doc comment. NewDevServer defaults this
	// to AgentKindDevServer; usecase.RegisterDevServer overrides it when the
	// caller supplies a valid explicit kind (e.g. AgentKindMobileEmulator).
	Kind AgentKind
}

// NewDevServer constructs a DevServer, enforcing the invariants a record
// must satisfy to be meaningful — this is where "infra-fleet-service owns
// this data's correctness" actually lives, not scattered validation in the
// gRPC handler.
func NewDevServer(id, tenantID, host string, mode ConnectionMode, sshTargetID string) (DevServer, error) {
	if tenantID == "" {
		return DevServer{}, ErrEmptyDevServerTenant
	}
	if host == "" {
		return DevServer{}, ErrEmptyHost
	}
	if !mode.Valid() {
		return DevServer{}, ErrInvalidConnectionMode
	}
	if mode == ConnectionModeRelaySSH && sshTargetID == "" {
		return DevServer{}, ErrMissingSSHTargetForRelaySSH
	}
	return DevServer{
		ID:          id,
		TenantID:    tenantID,
		Host:        host,
		Mode:        mode,
		SSHTargetID: sshTargetID,
		Status:      DevServerStatusPendingApproval,
		Kind:        AgentKindDevServer,
	}, nil
}

// IsZero reports whether ds is the zero-value DevServer — used by
// ResolveConnection's not-found branch to signal "no dev server", distinct
// from a real DevServer with a coincidentally empty field.
func (ds DevServer) IsZero() bool {
	return ds == DevServer{}
}
