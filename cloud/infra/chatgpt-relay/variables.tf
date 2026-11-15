variable "project_id" {
  type = string
}

variable "environment" {
  type = string
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "image" {
  description = "Relay image (cloud/apps/chatgpt-relay/build-image.sh prints it). Empty: the root creates only the registry and accounts."
  type        = string
  default     = ""
}
