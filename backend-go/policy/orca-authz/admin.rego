# admin-action checks — replaces auth-service's requireAdminActor inline
# `role == "admin"` check (execution-plan.md Epic E). Consumed as
# data.orca.authz.admin.allow via common/policy.Evaluator.
#
# input shape: {"actor": {"id": <string>, "role": <string>}}
package orca.authz.admin

import rego.v1

default allow := false

allow if {
	input.actor.role == "admin"
}

# Additive override consuming an AccessPolicy of kind "admin_override",
# name "extra_admins" — published by PolicyDataPublisher to
# data/admin_override/extra_admins.json. Absent by default (data.orca...
# undefined), so this clause is a no-op until an admin explicitly creates
# that policy — never changes behavior for a deployment that never uses it.
allow if {
	input.actor.id in data.orca.authz.admin_override.extra_admins.user_ids
}
